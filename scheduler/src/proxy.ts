// Copyright (c) 2021 Terminus, Inc.
//
// This program is free software: you can use, redistribute, and/or modify
// it under the terms of the GNU Affero General Public License, version 3
// or later ("AGPL"), as published by the Free Software Foundation.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
// FITNESS FOR A PARTICULAR PURPOSE.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <http://www.gnu.org/licenses/>.

import { createProxyMiddleware } from 'http-proxy-middleware';
import { Request, Response } from 'express';
import { getEnv, logger, getHttpUrl } from './util';
import { INestApplication } from '@nestjs/common';
import qs from 'query-string';

const isProd = process.env.NODE_ENV === 'production';

const { envConfig } = getEnv();
const { BACKEND_URL, GITTAR_ADDR, UC_BACKEND_URL, ENTERPRISE_URL, FDP_URL, AI_BACKEND_URL, ERDA_AI_BACKEND_URL, MONITOR_ADDR } =
  envConfig;

const API_URL = getHttpUrl(BACKEND_URL);
const UC_API_URL = getHttpUrl(UC_BACKEND_URL);
const ENTERPRISE_UI_URL = getHttpUrl(ENTERPRISE_URL);
const FDP_UI_URL = getHttpUrl(FDP_URL);
const AI_URL = getHttpUrl(AI_BACKEND_URL);
const ERDA_AI_URL = getHttpUrl(ERDA_AI_BACKEND_URL);
const MONITOR_URL = getHttpUrl(MONITOR_ADDR);

const GITTAR_URL = isProd ? getHttpUrl(GITTAR_ADDR) : API_URL;

const wsPathRegex = [
  /^\/api\/[^/]*\/websocket/,
  /^\/api\/[^/]*\/fdp-websocket/, // http-proxy-middleware can't handle multiple ws proxy https://github.com/chimurai/http-proxy-middleware/issues/463
  /^\/api\/[^/]*\/terminal/,
  /^\/api\/[^/]*\/apim-ws\/api-docs\/filetree/,
];

export const createProxyService = (app: INestApplication) => {
  const onError = (err, req, res: Response, target) => {
    const reqMsg = `${req.url} to ${target}`;
    try {
      if (!res.writableEnded) {
        const errMsg = `Error occurred while proxying request ${reqMsg}: ${err.message}`;
        res.end();
        logger.warn(errMsg, err);
      } else {
        logger.warn(`Response is ended before error handler while proxying request ${reqMsg}`);
      }
    } catch (e) {
      logger.error(`Error happens while handling proxy exception for request ${reqMsg}: ${e}`);
    }
  };
  const wsProxy = createProxyMiddleware(
    (pathname: string, req: Request) => {
      return req.headers.upgrade === 'websocket' && wsPathRegex.some((regex) => regex.test(pathname));
    },
    {
      target: API_URL,
      ws: true,
      changeOrigin: !isProd,
      xfwd: true,
      secure: false,
      pathRewrite: replaceApiOrgPath,
      onProxyReqWs: (proxyReq, req: Request, socket) => {
        if (isProd) {
          const { query } = qs.parseUrl(req.url);
          proxyReq.setHeader('org', query?.wsOrg);

          const host = req.headers.host || '';
          const domain = host.replace('local.', '').split(':')[0];
          if (domain) {
            proxyReq.setHeader('domain', domain);
          }
        }
        socket.on('error', (error) => {
          logger.warn('Websocket error:', error); // add error handler to prevent server crash https://github.com/chimurai/http-proxy-middleware/issues/463#issuecomment-676630189
        });
      },
      onError,
    },
  );
  // max-range 代理规则，必须放在 /api 之前
  app.use(
    createProxyMiddleware(
      (pathname: string) => {
        // 支持 /api/任意组织名/logs/download/max-range
        return /^\/api\/[^/]+\/logs\/download\/max-range$/.test(pathname);
      },
      {
        target: MONITOR_URL,
        changeOrigin: true,
        secure: false,
        pathRewrite: replaceApiOrgPath,
        onError,
      },
    ),
  );
  app.use(
    createProxyMiddleware(
      (pathname: string) => {
        return !!pathname.match('^/static/admin');
      },
      {
        target: ENTERPRISE_UI_URL,
        changeOrigin: !isProd,
        secure: false,
      },
    ),
  );
  app.use(
    createProxyMiddleware(
      (pathname: string) => {
        return !!pathname.match('^/static/fdp');
      },
      {
        target: FDP_UI_URL,
        changeOrigin: !isProd,
        secure: false,
        pathRewrite: { '^/static/fdp': '' },
        onError,
      },
    ),
  );
  app.use(wsProxy);
  app.use(
    createProxyMiddleware(
      (pathname: string) => {
        return !!pathname.match('^/api/uc');
      },
      {
        target: UC_API_URL,
        changeOrigin: true,
        secure: false,
        pathRewrite: (api) => (isProd ? api.replace('/api/uc', '') : api),
        onError,
      },
    ),
  );
  app.use(
    createProxyMiddleware(
      (pathname: string, req: Request) => {
        if (pathname.startsWith('/api/ai-proxy/')) {
          return true;
        }
      },
      {
        target: AI_URL,
        changeOrigin: !isProd,
        onError,
      },
    ),
  );
  app.use(
    createProxyMiddleware(
      (pathname: string, req: Request) => {
        if (pathname.startsWith('/api/knowledgebase/') || pathname.startsWith('/api/query')) {
          return true;
        }
      },
      {
        target: ERDA_AI_URL,
        changeOrigin: true,
        onError,
      },
    ),
  );
  app.use(
    createProxyMiddleware(
      (pathname: string) => {
        return !!pathname.match('^/api');
      },
      {
        target: API_URL,
        changeOrigin: !isProd,
        xfwd: true,
        secure: false,
        pathRewrite: replaceApiOrgPath,
        headers: {
          Connection: 'keep-alive', // try fix error: write after end
        },
        onProxyReq: (proxyReq, req: Request) => {
          if (!isProd) {
            proxyReq.setHeader('referer', API_URL);
          } else {
            const host = req.headers.host || '';
            const domain = host.replace('local.', '').split(':')[0];
            const org = extractOrg(req.originalUrl); // api/files not append org to path,org not exist in this condition

            if (org) {
              proxyReq.setHeader('org', org);
            }
            if (domain) {
              proxyReq.setHeader('domain', domain);
            }
          }
        },
        onError,
      },
    ),
  );
  app.use(
    createProxyMiddleware(
      (pathname: string, req: Request) => {
        if (pathname.startsWith('/wb/')) {
          return true;
        }
        const userAgent = req.headers['user-agent'];
        if (userAgent.toLowerCase().includes('git')) {
          // compatible with JGit
          return /[^/]*\/dop/.test(pathname);
        }
        return false;
      },
      {
        target: GITTAR_URL,
        changeOrigin: !isProd,
        onError,
      },
    ),
  );
  app.use(
    '/metadata.json',
    createProxyMiddleware({
      target: API_URL,
      changeOrigin: !isProd,
      onError,
    }),
  );
  return wsProxy;
};

const replaceApiOrgPath = (p: string) => {
  if (isProd) {
    const match = /\/api\/([^/]*)\/(.*)/.exec(p); // /api/orgName/path => /api/path
    if (match && !p.startsWith('/api/files')) {
      if (wsPathRegex.some((regex) => regex.test(p))) {
        if (Object.keys(qs.parseUrl(p).query).length) {
          return `/api/${match[2]}&wsOrg=${match[1]}`;
        }
        return `/api/${match[2]}?wsOrg=${match[1]}`;
      }
      return `/api/${match[2]}`;
    }
  }
  return p;
};

const extractOrg = (p: string) => {
  const match = /^\/[^/]*\/([^/]*)\/?/.exec(p);
  if (match && !p.startsWith('/api/files')) {
    return match[1];
  }
  return '';
};
