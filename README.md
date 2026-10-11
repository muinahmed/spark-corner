# Spark Corner — Complete Deno E-commerce

## Run

Open a terminal in this folder and run:

    $env:ADMIN_USERNAME="admin"
    $env:ADMIN_PASSWORD="choose-a-long-unique-password"
    deno task start

Or:

    deno task start

Then open:

    http://localhost:8000

## Admin

URL:
    http://localhost:8000/admin/login

Credentials are required environment variables; they are not stored in the code.

    ADMIN_USERNAME=your-admin-username
    ADMIN_PASSWORD=a-long-unique-password

For local development, copy `.env.example` to `.env`, then run `deno task --env-file=.env start`. Do not commit `.env`.

## Railway deployment

1. Add a Railway Volume mounted at `/app/data`.
2. Set `DATA_DIR=/app/data` so orders and uploaded product images persist after deployments.
3. Set `ADMIN_USERNAME` and a long, unique `ADMIN_PASSWORD` in Railway Variables.
4. Railway provides `PORT` automatically. The app reads it and falls back to `8000` locally.

Bundled storefront images, including the hero banner, are always served from `./public/images`. Uploaded product images are served from `DATA_DIR/uploads/products`.

## Features

- Product catalogue
- Search and categories
- Product details
- Product variants
- Guest cart
- Variant-safe quantity and remove actions
- Guest checkout
- Cash on Delivery / bKash / Nagad selection
- Orders stored in SQLite
- Admin login/session
- Product CRUD
- Image upload through admin UI
- Categories
- Order management and status updates
- Responsive design

## Important

This is a development-ready project, not a finished production payment/courier integration. bKash and Nagad are currently stored as the selected payment method; there is no live payment gateway. Courier integration is not included.

Back up your existing `database/shop.sqlite` before replacing project files if you want to preserve existing data.
