const compose = require('koa-compose');
const debug = require('debug')('oidc-provider:introspection');

const PARAM_LIST = new Set(['token', 'token_type_hint']);

const presence = require('../helpers/validate_presence');
const authAndParams = require('../shared/chains/client_auth');
const noCache = require('../shared/no_cache');
const mask = require('../helpers/claims');
const instance = require('../helpers/weak_cache');

module.exports = function introspectionAction(provider) {
  const Claims = mask(instance(provider).configuration());
  const { grantTypeHandlers } = instance(provider);

  function getAccessToken(token) {
    return provider.AccessToken.find(token);
  }

  async function getClientCredentials(token) {
    /* istanbul ignore if */
    if (!grantTypeHandlers.has('client_credentials')) return undefined;
    return provider.ClientCredentials.find(token);
  }

  async function getRefreshToken(token) {
    /* istanbul ignore if */
    if (!grantTypeHandlers.has('refresh_token')) return undefined;
    return provider.RefreshToken.find(token);
  }

  function findResult(results) {
    return results.find(found => !!found);
  }

  return compose([

    // TODO: remove in 3.x
    async function deprecatedTokenType(ctx, next) {
      await next();
      const token = ctx.oidc.entities.AccessToken ||
        ctx.oidc.entities.ClientCredentials ||
        ctx.oidc.entities.RefreshToken;

      switch (token && token.kind) { // eslint-disable-line default-case
        case 'AccessToken':
          ctx.body.token_type = 'access_token';
          break;
        case 'ClientCredentials':
          ctx.body.token_type = 'client_credentials';
          break;
        case 'RefreshToken':
          ctx.body.token_type = 'refresh_token';
          break;
      }
    },

    noCache,

    authAndParams(provider, PARAM_LIST, 'introspection'),

    async function validateTokenPresence(ctx, next) {
      presence(ctx, ['token']);
      await next();
    },

    async function debugOutput(ctx, next) {
      await next();
      debug(
        'uuid=%s by client=%s token=%s response=%o',
        ctx.oidc.uuid,
        ctx.oidc.client.clientId,
        ctx.oidc.params.token, ctx.body,
      );
    },

    async function renderTokenResponse(ctx, next) {
      const { params } = ctx.oidc;

      ctx.body = { active: false };

      let token;

      switch (params.token_type_hint) {
        case 'access_token':
          token = await getAccessToken(params.token)
            .then((result) => {
              if (result) return result;
              return Promise.all([
                getClientCredentials(params.token),
                getRefreshToken(params.token),
              ]).then(findResult);
            });
          break;
        case 'client_credentials':
          token = await getClientCredentials(params.token)
            .then((result) => {
              if (result) return result;
              return Promise.all([
                getAccessToken(params.token),
                getRefreshToken(params.token),
              ]).then(findResult);
            });
          break;
        case 'refresh_token':
          token = await getRefreshToken(params.token)
            .then((result) => {
              if (result) return result;
              return Promise.all([
                getAccessToken(params.token),
                getClientCredentials(params.token),
              ]).then(findResult);
            });
          break;
        default:
          token = await Promise.all([
            getAccessToken(params.token),
            getClientCredentials(params.token),
            getRefreshToken(params.token),
          ]).then(findResult);
      }

      if (!token || !token.isValid) {
        return;
      }

      if (ctx.oidc.client.introspectionEndpointAuthMethod === 'none') {
        if (token.clientId !== ctx.oidc.client.clientId) {
          return;
        }
      }

      switch (token.kind) {
        case 'AccessToken':
        case 'ClientCredentials':
        case 'RefreshToken':
          ctx.oidc.entity(token.kind, token);
          break;
        /* istanbul ignore next */
        default:
          return;
      }

      if (token.clientId !== ctx.oidc.client.clientId) {
        ctx.body.sub = Claims.sub(
          token.accountId,
          (await provider.Client.find(token.clientId)).sectorIdentifier,
        );
      } else {
        ctx.body.sub = Claims.sub(token.accountId, ctx.oidc.client.sectorIdentifier);
      }

      Object.assign(ctx.body, {
        active: true,
        client_id: token.clientId,
        exp: token.exp,
        iat: token.iat,
        sid: token.sid,
        iss: token.iss,
        jti: token.jti,
        scope: token.scope,
      });

      await next();
    },
  ]);
};
