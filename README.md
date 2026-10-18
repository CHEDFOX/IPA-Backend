# IPA Backend

The API, media server and admin panel behind the IPA real estate & land website
([IPA-Web](https://github.com/CHEDFOX/IPA-Web)). It runs on your VPS.

- **Admin panel** at `/admin`: add properties, upload photos, videos, a site plan and a PDF
  brochure, read enquiries, and edit the site text and contact details.
- **Media**: every photo is turned into web sizes (640, 1280 and 2048 px WebP) plus a
  1200×630 JPEG for link previews in WhatsApp and other apps. Location data (GPS) is removed from
  photos and videos. Videos are repackaged so they start playing straight away, and get a poster frame.
- **Public API** used by the website: listings, settings, private links and the enquiry form.
- **Website refresh**: after each change in the admin panel the website is told to refresh, so
  edits show within seconds.

Stack: Node.js 22, Express 5, SQLite (one file, no database server), sharp for images,
ffmpeg for videos.

## Run it locally

```bash
npm install
cp .env.example .env        # set ADMIN_PASSWORD at least
npm run dev                 # http://localhost:4000/admin
npm run seed                # optional: sample listings with placeholder photos
npm test
```

## Deploy

The backend runs on your VPS with Docker; Caddy in front of it gets the HTTPS certificate
automatically. The website runs on Vercel. **[DEPLOY.md](DEPLOY.md)** walks through both, step by
step, including DNS, backups and troubleshooting. In short:

```bash
git clone https://github.com/CHEDFOX/IPA-Backend.git /opt/ipa-backend
cd /opt/ipa-backend
cp .env.example .env && nano .env      # API_DOMAIN, ADMIN_PASSWORD, PUBLIC_URL, SITE_URL, REVALIDATE_SECRET
docker compose up -d --build           # backend + Caddy (HTTPS)
```

Then open `https://api.yourdomain.com/admin`. Update with
`git pull && docker compose up -d --build`; back up with
`docker compose exec -T backend node scripts/backup.js` plus a copy of the `data/media` folder.

Without Docker: `deploy/ipa-backend.service` (systemd) with `deploy/nginx.conf` (nginx + certbot).

## Settings (`.env`)

| Variable | What it does |
| --- | --- |
| `ADMIN_PASSWORD` | Admin panel password (10+ characters). Required. |
| `PUBLIC_URL` | This backend's public address; media links are built from it. |
| `SITE_URL` | The website's address (QR codes, "View on site" links). |
| `WEB_REVALIDATE_URL`, `REVALIDATE_SECRET` | Lets the backend refresh the website after edits. Same secret as the website. |
| `CORS_ORIGINS` | Website addresses allowed to send the enquiry form. Defaults to `SITE_URL`. |
| `MAX_UPLOAD_MB` | Largest single upload (default 1024). |
| `DATA_DIR` | Where the database and files are stored (default `./data`). |
| `KEEP_ORIGINALS` | Keep original photo files, not served (default `true`). |
| `SMTP_URL`, `NOTIFY_EMAIL`, `MAIL_FROM` | Optional email for every new enquiry. |
| `TRUST_PROXY` | Proxy hops to trust for client IPs (default `loopback`). |

## Media tips

- Photos: JPEG, PNG, WebP or AVIF. iPhone HEIC photos must be exported as JPEG
  (iPhone: Settings → Camera → Formats → Most Compatible).
- Videos: MP4 (H.264) plays everywhere. MOV and WebM are accepted. Videos are not re-encoded,
  so export drone footage at 1080p to keep files small.
- The first photo in a listing is its cover on cards and link previews.

## API

Public (used by the website):

| Method | Path | |
| --- | --- | --- |
| GET | `/api/site` | Settings, hero image, portrait, locations, counts |
| GET | `/api/properties?type=&status=&location=&featured=1` | Public listings (cards) |
| GET | `/api/properties/:slug` | One public listing |
| GET | `/api/share/:token` | A listing by private link (any visibility) |
| POST | `/api/enquiries` | Enquiry form |
| GET | `/media/...` | Photos, videos, PDFs |

Admin endpoints live under `/api/admin` and need a signed-in session.
