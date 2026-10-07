# Spark Corner — Complete Deno E-commerce

## Run

Open a terminal in this folder and run:

    deno run --allow-net --allow-read --allow-write main.js

Or:

    deno task start

Then open:

    http://localhost:8000

## Admin

URL:
    http://localhost:8000/admin/login

Development credentials:
    Username: admin
    Password: admin123

Change these in `main.js` before using the site publicly.

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
