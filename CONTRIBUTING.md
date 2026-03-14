# Contributing to API Center

Thank you for contributing! Please follow these guidelines to keep the codebase clean and consistent.

---

## Getting Started

1. Fork the repository and clone your fork
2. Create a new branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Copy the environment file:
   ```bash
   cp .env.example .env
   ```

---

## Development Workflow

1. Make your changes in the `src/` directory
2. Run the linter to check for issues:
   ```bash
   npm run lint
   ```
3. Run tests:
   ```bash
   npm test
   ```
4. Build to verify TypeScript compiles:
   ```bash
   npm run build
   ```

---

## Branch Naming

| Type | Format | Example |
|---|---|---|
| Feature | `feature/description` | `feature/add-weather-api` |
| Bug fix | `fix/description` | `fix/kafka-reconnect` |
| Refactor | `refactor/description` | `refactor/tribe-registry` |
| Docs | `docs/description` | `docs/update-readme` |

---

## Commit Messages

Use clear, concise commit messages:

```
feat: add weather external API integration
fix: handle Kafka disconnect gracefully
docs: update README with new tribe setup steps
refactor: extract auth middleware into separate module
```

---

## Pull Requests

- Keep PRs focused on a single change
- Provide a clear description of what changed and why
- Ensure all tests pass and the build succeeds
- Request a review from at least one team member

---

## Code Style

- Follow the existing TypeScript conventions in the codebase
- Use the ESLint configuration provided (`.eslintrc.json`)
- Add JSDoc comments to exported functions and classes
- Keep files focused — one module per file

---

## Adding External APIs

See the [README](README.md#adding-a-new-external-api) for step-by-step instructions.

---

## Questions?

Open an issue or reach out to the team if you're unsure about anything.
