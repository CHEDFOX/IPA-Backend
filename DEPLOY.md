# Going live: backend on your VPS, website on Vercel

```
yourdomain.com      ──►  Vercel   (IPA-Web: the public website)
api.yourdomain.com  ──►  your VPS (IPA-Backend: admin panel, photos, videos, listings)
```

Visitors open the website on Vercel. Photos and videos load straight from your VPS. When you
save something in the admin panel, the backend tells Vercel to refresh, so changes show within
seconds.

Do the steps in order: the website's first build needs the backend to be running.

## What you need

- A VPS running Ubuntu 22.04 or 24.04 (1 GB RAM works, 2 GB is comfortable) with SSH access and
  ports 80 and 443 open. Disk: about 3 MB per photo (web sizes plus the original), and videos
  take their own size.
- A domain name you can add DNS records to.
- A Vercel account. Vercel's free Hobby plan is for personal, non-commercial use only; a site
  that promotes a business needs the **Pro** plan.
- The two GitHub repositories, `CHEDFOX/IPA-Backend` and `CHEDFOX/IPA-Web`.

## 1. Point the API domain at the VPS

At your domain registrar, add:

| Type | Name | Value |
| --- | --- | --- |
| A | `api` | your VPS's IP address |

(The website's records come from Vercel in step 6.)

## 2. Install Docker on the VPS

```bash
ssh root@YOUR_VPS_IP
curl -fsSL https://get.docker.com | sh
# If the ufw firewall is on:
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443
```

## 3. Download and configure the backend

```bash
git clone https://github.com/CHEDFOX/IPA-Backend.git /opt/ipa-backend
cd /opt/ipa-backend
cp .env.example .env
openssl rand -hex 32        # copy the output: it is your REVALIDATE_SECRET
nano .env
```

If the repository is private, Git asks for your GitHub username and a personal access token
(github.com → Settings → Developer settings → Personal access tokens) instead of a password.

Fill in `.env`:

| Setting | Value |
| --- | --- |
| `API_DOMAIN` | `api.yourdomain.com` |
| `ADMIN_PASSWORD` | a long password for the admin panel |
| `PUBLIC_URL` | `https://api.yourdomain.com` |
| `SITE_URL` | `https://yourdomain.com` (until your domain is on Vercel, use the Vercel address such as `https://ipa-web.vercel.app`) |
| `WEB_REVALIDATE_URL` | `https://yourdomain.com/api/revalidate` (same host as `SITE_URL`) |
| `REVALIDATE_SECRET` | the random string from `openssl rand -hex 32` |

Save with Ctrl+O, Enter, then Ctrl+X.

## 4. Start it

```bash
docker compose up -d --build
docker compose ps           # after a minute, backend shows "healthy"
```

This starts the backend and Caddy, which gets the HTTPS certificate for `api.yourdomain.com` by
itself. Open **https://api.yourdomain.com/admin** and sign in with `ADMIN_PASSWORD`.

> Already running nginx on this VPS for other sites? Start only the backend with
> `docker compose up -d backend`, then use `deploy/nginx.conf` and `certbot --nginx`.

## 5. Add your details and first properties

In the admin panel:

1. **Settings**: site name, WhatsApp number, phone, email, currency, About text, and optionally
   a large photo for the home page. Save.
2. **Properties → New property**: fill in the details, upload photos and videos, choose
   **Public** and save. Tick "Feature on the home page" for the ones to show first.

## 6. Deploy the website on Vercel

1. vercel.com → **Add New → Project** → import `CHEDFOX/IPA-Web`. Leave the build settings as
   they are.
2. Under **Environment Variables** add:

   | Name | Value |
   | --- | --- |
   | `NEXT_PUBLIC_API_URL` | `https://api.yourdomain.com` |
   | `NEXT_PUBLIC_SITE_URL` | `https://yourdomain.com` (leave it out until the domain is connected) |
   | `REVALIDATE_SECRET` | the same string as in the backend's `.env` |

3. **Deploy**. You get an address like `https://ipa-web.vercel.app` with your listings on it.
4. **Settings → Domains**: add `yourdomain.com` and `www.yourdomain.com`, then add the DNS records
   Vercel shows you at your registrar. Leave the `api` record as it is.
5. **Settings → Functions**: pick the region closest to your VPS.

## 7. Connect the two

Once the domain works on Vercel:

- On the VPS, check `SITE_URL` and `WEB_REVALIDATE_URL` in `.env` use `https://yourdomain.com`, then
  apply with `docker compose up -d`.
- In Vercel, set `NEXT_PUBLIC_SITE_URL=https://yourdomain.com` and redeploy
  (Deployments → ⋯ → Redeploy).

Check that everything is wired up:

- Change a price in the admin panel, then reload the property page: it updates within seconds.
- Send yourself a property link on WhatsApp: the preview shows the photo, title and price.
- Send the enquiry form on a property page: it appears under **Enquiries** in the admin panel.

## Updating

```bash
cd /opt/ipa-backend && git pull && docker compose up -d --build
```

The website redeploys on Vercel by itself whenever the repository's production branch changes
(the default branch; see Vercel → Settings → Git).

## Backups

Everything lives in `/opt/ipa-backend/data`: the database `ipa.db` and the `media` folder.

```bash
# Database copy (keeps the latest 14) into data/backups:
docker compose exec -T backend node scripts/backup.js
```

Run it nightly with `crontab -e`:

```
0 3 * * * cd /opt/ipa-backend && docker compose exec -T backend node scripts/backup.js
```

Also copy `data/` off the server now and then (your VPS provider's snapshots, or `rsync` to
another machine).

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `https://api.yourdomain.com` doesn't load | The `api` DNS record may still be spreading (up to an hour), or ports 80/443 are closed. `docker compose logs caddy` shows certificate errors. |
| The website shows no listings | Check `NEXT_PUBLIC_API_URL` in Vercel, and that the properties are **Public**. `https://api.yourdomain.com/api/properties` should list them. |
| Edits take a minute instead of seconds | `REVALIDATE_SECRET` differs between Vercel and `.env`, or `WEB_REVALIDATE_URL` is wrong. `docker compose logs backend \| grep refresh` shows the error. |
| Enquiry form says it could not connect | `SITE_URL` must be the address visitors use (`www.` and without are both allowed). For other addresses set `CORS_ORIGINS`. |
| A big video fails to upload | The limit is 1 GB (`MAX_UPLOAD_MB` and `max_size` in `deploy/Caddyfile`). Export videos at 1080p to keep them smaller. |
| Forgot the admin password | Change `ADMIN_PASSWORD` in `.env`, then `docker compose up -d`. |
