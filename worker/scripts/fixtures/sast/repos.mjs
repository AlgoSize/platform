// Representative repository shapes for the language profiler.
//
// A fixture here is a TREE LISTING, not a directory of files, because that is
// what the profiler actually consumes: the Worker has no filesystem, and a
// repository reaches it as a flat path list from the GitHub git-tree API.
//
// The consequence is that a realistic monorepo is twenty lines instead of a
// hundred checked-in files, and a reviewer can see the entire fixture at once
// and judge whether the expected detection is right. `contents` carries only
// the manifests a real scan would already have fetched — dependency names are
// the strongest framework signal and cannot be read from a path.

/** Node + TypeScript + Next.js + React. */
export const NEXT_TS_APP = {
  entries: [
    "package.json", "package-lock.json", "tsconfig.json", "next.config.js",
    ".eslintrc.json", "README.md",
    "src/app/layout.tsx", "src/app/page.tsx", "src/app/api/users/route.ts",
    "src/components/Button.tsx", "src/lib/db.ts", "src/lib/auth.ts",
    "public/logo.svg",
    "node_modules/react/index.js", "node_modules/next/dist/server.js",
    ".next/static/chunks/main.js",
  ],
  contents: {
    "package.json": JSON.stringify({
      name: "web",
      dependencies: { next: "^14.0.0", react: "^18.2.0", "react-dom": "^18.2.0" },
      devDependencies: { typescript: "^5.3.0" },
    }),
  },
};

/** Python + Flask, with a requirements.txt the audit can actually read. */
export const PYTHON_FLASK = {
  entries: [
    "requirements.txt", "app.py", "wsgi.py",
    "app/__init__.py", "app/routes.py", "app/models.py",
    "tests/test_routes.py", "Dockerfile", ".env.example",
    "__pycache__/app.cpython-311.pyc", ".venv/lib/python3.11/site-packages/flask/__init__.py",
  ],
  contents: {
    "requirements.txt": "Flask==3.0.0\nSQLAlchemy>=2.0\ngunicorn==21.2.0\n",
  },
};

/** Python + Django, detected through manage.py rather than a dependency. */
export const PYTHON_DJANGO = {
  entries: [
    "manage.py", "requirements.txt",
    "project/settings.py", "project/urls.py", "project/wsgi.py",
    "blog/models.py", "blog/views.py", "blog/admin.py",
  ],
  contents: { "requirements.txt": "Django==5.0\npsycopg2-binary==2.9.9\n" },
};

/** Java + Spring Boot via Maven. */
export const JAVA_SPRING = {
  entries: [
    "pom.xml", "src/main/resources/application.yml",
    "src/main/java/com/acme/Application.java",
    "src/main/java/com/acme/web/UserController.java",
    "src/main/java/com/acme/repo/UserRepository.java",
    "src/test/java/com/acme/ApplicationTests.java",
    "target/classes/com/acme/Application.class",
  ],
  contents: {
    "pom.xml": `<project><dependencies>
      <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
    </dependencies></project>`,
  },
};

/** Ruby on Rails. */
export const RUBY_RAILS = {
  entries: [
    "Gemfile", "Gemfile.lock", "Rakefile", "config.ru",
    "config/routes.rb", "config/application.rb", "config/database.yml",
    "app/controllers/application_controller.rb", "app/controllers/users_controller.rb",
    "app/models/user.rb", "app/views/users/index.html.erb",
    "vendor/bundle/ruby/3.2.0/gems/rails/lib/rails.rb",
  ],
  contents: { "Gemfile": 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\ngem "puma"\n' },
};

/** A Go service using the standard library, plus Gin. */
export const GO_SERVICE = {
  entries: [
    "go.mod", "go.sum", "main.go",
    "internal/handler/users.go", "internal/store/db.go",
    "Dockerfile", ".github/workflows/ci.yml",
  ],
  contents: {
    "go.mod": "module example.com/svc\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n",
    "main.go": 'package main\n\nimport (\n\t"net/http"\n\t"github.com/gin-gonic/gin"\n)\n',
  },
};

/**
 * A mixed monorepo: TypeScript frontend, Python backend, Rust worker, and
 * infrastructure. The case the old thirteen-extension filter handled worst —
 * the Rust crate and the Terraform were invisible to it.
 */
export const MIXED_MONOREPO = {
  entries: [
    "package.json", "pnpm-lock.yaml",
    "apps/web/package.json", "apps/web/tsconfig.json", "apps/web/next.config.js",
    "apps/web/src/pages/index.tsx", "apps/web/src/lib/api.ts",
    "services/api/requirements.txt", "services/api/main.py", "services/api/routes.py",
    "services/worker/Cargo.toml", "services/worker/Cargo.lock",
    "services/worker/src/main.rs", "services/worker/src/queue.rs",
    "infra/main.tf", "infra/variables.tf",
    "deploy/docker-compose.yml", "deploy/Dockerfile",
    ".github/workflows/ci.yml", ".github/workflows/deploy.yml",
    "node_modules/typescript/lib/tsc.js",
    "apps/web/.next/server/pages/index.js",
    "target/debug/worker",
  ],
  contents: {
    "apps/web/package.json": JSON.stringify({ dependencies: { next: "14.1.0", react: "18.2.0" } }),
    "services/api/requirements.txt": "fastapi==0.109.0\nuvicorn==0.27.0\n",
  },
};

/**
 * A repository the scanner has NO code support for, but which is not empty.
 *
 * The regression this pins is the one the profiler exists for: a Swift/Kotlin
 * repository used to be fetched as zero files and reported as having no
 * readable source, which is indistinguishable from an empty repository.
 */
export const UNSUPPORTED_MOBILE = {
  entries: [
    "Package.swift", "Sources/App/main.swift", "Sources/App/Model.swift",
    "android/build.gradle.kts", "android/app/src/main/kotlin/com/acme/Main.kt",
    "fastlane/Fastfile", "README.md",
  ],
  contents: {},
};

/**
 * Directory names that LOOK like framework signals and are not.
 *
 * `pages/` and `app/` are Next.js conventions, Rails conventions, and also
 * just words. A repository with both and no dependency on either framework
 * must not be reported as running them — that sends a reviewer hunting for
 * `getServerSideProps` in a static site.
 */
export const FALSE_SIGNAL_STATIC_SITE = {
  entries: [
    "index.html", "pages/about.html", "pages/contact.html",
    "app/styles.css", "assets/logo.png", "Makefile",
  ],
  contents: {},
};

export const ALL_REPO_FIXTURES = Object.freeze({
  NEXT_TS_APP, PYTHON_FLASK, PYTHON_DJANGO, JAVA_SPRING, RUBY_RAILS,
  GO_SERVICE, MIXED_MONOREPO, UNSUPPORTED_MOBILE, FALSE_SIGNAL_STATIC_SITE,
});
