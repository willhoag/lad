const qs = require('qs');
const Boom = require('boom');
const s = require('underscore.string');
const { getLanguage } = require('country-language');
const moment = require('moment');
const _ = require('lodash');
const i18n = require('i18n');

const config = require('../config');
const logger = require('./logger');

// <https://github.com/mashpie/i18n-node>
i18n.api = {};
i18n.configure({
  directory: config.localesDirectory,
  locales: config.locales,
  logDebugFn: logger.debug.bind(logger),
  logWarnFn: logger.warn.bind(logger),
  logErrorFn: logger.error.bind(logger),
  cookiename: 'locale',
  indent: '  ',
  api: {
    __: 't',
    __n: 'tn',
    __l: 'tl',
    __h: 'th',
    __mf: 'tmf'
  },
  register: i18n.api,
  defaultLocale: config.defaultLocale,
  syncFiles: config.i18nSyncFiles,
  autoReload: config.i18nAutoReload,
  updateFiles: config.i18nUpdateFiles
});

i18n.translate = function(key, locale) {
  let args = _.values(arguments).slice(2);
  if (_.isUndefined(args)) args = [];
  const phrase = config.i18n[key];
  if (!_.isString(phrase)) {
    logger.warn(`translation key missing: ${key}`);
    return;
  }
  args = [{ phrase, locale }, ...args];
  return i18n.api.t(...args);
};

i18n.middleware = function(ctx, next) {
  // expose api methods to `ctx.req` and `ctx.state`
  i18n.init(ctx.req, ctx.state);

  // override the existing locale detection with our own
  // in order of priority:
  //
  // 1. check the URL, if `/de` then locale is `de`
  // 2. check the cookie
  // 3. check Accept-Language last

  let locale = config.defaultLocale;

  if (_.includes(config.locales, ctx.url.split('/')[1]))
    locale = ctx.url.split('/')[1];
  else if (
    ctx.cookies.get('locale') &&
    _.includes(config.locales, ctx.cookies.get('locale'))
  )
    locale = ctx.cookies.get('locale');
  else if (ctx.request.acceptsLanguages(config.locales))
    locale = ctx.request.acceptsLanguages(config.locales);

  // TODO: should we expose this as `ctx.basePath`?
  let basePath = ctx.path;
  if (basePath.indexOf(`/${locale}`) === 0)
    basePath = basePath.replace(`/${locale}`, '');

  // set the locale properly
  i18n.setLocale([ctx.req, ctx.state], locale);

  // if the locale was not available then redirect user
  if (locale !== ctx.state.locale)
    return ctx.redirect(
      `/${ctx.state.locale}${basePath}${_.isEmpty(ctx.query)
        ? ''
        : `?${qs.stringify(ctx.query)}`}`
    );

  // available languages for a dropdown menu to change language
  ctx.state.availableLanguages = _.sortBy(
    _.map(config.locales, locale => {
      return {
        locale,
        url: `/${locale}${basePath}${_.isEmpty(ctx.query)
          ? ''
          : `?${qs.stringify(ctx.query)}`}`,
        name: getLanguage(locale).name[0]
      };
    }),
    'name'
  );

  // get the name of the current locale's language in native language
  ctx.state.currentLanguage = s.titleize(
    getLanguage(ctx.req.locale).nativeName[0]
  );

  // bind `ctx.translate` as a helper func
  // so you can pass `ctx.translate('SOME_KEY_IN_CONFIG');` and it will lookup
  // `config.i18n['SOME_KEY_IN_CONFIG']` to get a specific and constant message
  // and then it will call `t` to translate it to the user's locale
  ctx.translate = function() {
    if (!_.isString(arguments[0]) || !_.isString(config.i18n[arguments[0]]))
      return ctx.throw(
        Boom.badRequest('Translation for your locale failed, try again')
      );
    arguments[0] = config.i18n[arguments[0]];
    return ctx.req.t(...arguments);
  };

  return next();
};

i18n.redirect = async function(ctx, next) {
  // inspired by nodejs.org language support
  // <https://github.com/nodejs/nodejs.org/blob/master/server.js#L38-L58>
  const locale = ctx.url.split('/')[1].split('?')[0];
  const hasLang = _.includes(config.locales, locale);

  // if the URL did not have a valid language found
  // then redirect the user to their detected locale
  if (!hasLang) {
    ctx.status = 302;
    let redirect = `/${ctx.req.locale}${ctx.url}`;
    if (!_.isEmpty(ctx.query)) redirect += `?${qs.stringify(ctx.query)}`;
    return ctx.redirect(redirect);
  }

  // set the cookie for future requests
  ctx.cookies.set('locale', locale, {
    signed: true,
    expires: moment()
      .add(1, 'year')
      .toDate(),
    // TODO: probably need to change this
    secure: !_.isEmpty(config.ssl.web)
  });

  // if the user is logged in, then save it as `last_locale`
  if (ctx.isAuthenticated()) {
    ctx.state.user.last_locale = locale;
    try {
      await ctx.state.user.save();
    } catch (err) {
      logger.error(err);
    }
  }

  return next();
};

module.exports = i18n;
