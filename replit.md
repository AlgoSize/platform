# Snowlake Jekyll Theme

## Project Overview
Snowlake is a professional, high-performance, SEO-friendly Jekyll theme for creative businesses, startups, and portfolios. It is a static site with blog, portfolio, and shop sections.

## Tech Stack
- **Static Site Generator:** Jekyll ~> 4.3.2
- **Language:** Ruby 3.2 (managed by Bundler)
- **Templating:** Liquid
- **Frontend:** Bootstrap, jQuery, Slider Revolution
- **Plugins:** jekyll-feed, jekyll-paginate-v2, jekyll-archives

## Project Structure
- `_config.yml` — Main Jekyll configuration
- `_data/` — YAML data files (navigation, settings, etc.)
- `_includes/` — Reusable HTML partials
- `_layouts/` — Page layout templates
- `_posts/` — Blog posts (Markdown)
- `_portfolio/` — Portfolio collection
- `_shop_items/` — Shop items collection
- `_authors/` — Authors collection
- `assets/` — CSS, JS, images
- `_site/` — Jekyll build output (generated, not committed)

## Running the Project
The workflow runs Jekyll's dev server on port 5000:
```
bundle exec jekyll serve --host 0.0.0.0 --port 5000 --livereload
```

## Deployment
- **Type:** Static site
- **Build command:** `bundle exec jekyll build`
- **Public directory:** `_site`

## Key Configuration
- `_config.yml`: Site URL, plugins, pagination, archives
- `Gemfile`: Ruby gem dependencies
- `_data/general_settings.yml`: Global theme settings (branding, SEO, social)
