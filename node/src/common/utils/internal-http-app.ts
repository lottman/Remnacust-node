import express, { json, Express, RequestHandler } from 'express';

export function createInternalHttpApp(
    authenticate: RequestHandler,
    forward: RequestHandler,
    routes: string[],
): Express {
    const app = express();
    // Reject local callers before parsing their body. Only the small Xray webhook
    // uses POST here; the configuration itself is returned by GET.
    app.use(authenticate);
    app.use(json({ limit: '1mb' }));
    app.use(routes, (req, res, next) => {
        req.url = req.originalUrl;
        forward(req, res, next);
    });
    return app;
}
