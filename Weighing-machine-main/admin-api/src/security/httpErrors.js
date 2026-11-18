'use strict';

const isProd = () => process.env.NODE_ENV === 'production';

function publicErrorMessage(err, fallback = 'Request failed') {
  if (!err) return fallback;
  if (isProd()) {
    const status = Number(err.status || err.statusCode) || 0;
    if (status >= 400 && status < 500 && err.message) return err.message;
    return fallback;
  }
  return err.message || fallback;
}

function sendError(res, err, status = 500) {
  const code = Number(err?.status || err?.statusCode) || status;
  return res.status(code).json({
    ok: false,
    error: publicErrorMessage(err, code >= 500 ? 'Internal error' : 'Request failed'),
  });
}

module.exports = {
  publicErrorMessage,
  sendError,
};
