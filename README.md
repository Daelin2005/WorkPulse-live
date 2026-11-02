# WorkPulse

WorkPulse is a Node.js/Express app that serves its pages and API from the same
origin and stores data in PostgreSQL.

## Run locally

1. Install Node.js 18 or newer and PostgreSQL.
2. Copy `.env.example` to `.env` and set `DATABASE_URL` to your PostgreSQL
   connection string.
3. Install dependencies and initialize the database:

   ```sh
   npm ci
   npm run db:init
   ```

4. Start the app with `npm start`, then open `http://localhost:3000`.

## Deploy from GitHub to Render

1. Push this repository to GitHub. Keep `.env` out of Git; `.gitignore` excludes
   it. Commit and push `render.yaml` with the application files.
2. In Render, choose **New + > Blueprint**, connect the GitHub repository, and
   deploy the Blueprint. Render reads `render.yaml` to create the Node web
   service and PostgreSQL database.
3. The web service runs `npm run db:init` before starting. This applies
   `database.sql` only when the database has not been initialized yet; later
   deploys leave existing data and schema in place. The service health check is
   `/api/health`.
4. Open the Render service URL to use the app. `RENDER_EXTERNAL_URL` is used as
   the default app origin; set `APP_ORIGIN` in the Render dashboard only if you
   use a custom domain.

The Blueprint uses Render's free plans for initial testing. Check Render's
current database retention and service-sleep limits before relying on a free
deployment for persistent or production use.

**Production email is not configured.** Invitation and password-reset email
delivery currently raises an error in production; configure a mail provider
before relying on those flows.
