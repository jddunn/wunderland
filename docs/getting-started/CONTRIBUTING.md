# Contributing to Voice Coding Assistant

Thank you for considering contributing to Voice Coding Assistant! This document provides guidelines and instructions for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Environment](#development-environment)
- [Development Workflow](#development-workflow)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Documentation](#documentation)
- [Issue Reporting](#issue-reporting)
- [Feature Requests](#feature-requests)

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for everyone.

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- Git
- OpenAI API key for development
- (Optional) OpenRouter API key

### Setting Up Development Environment

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR-USERNAME/voice-chat-assistant.git
   cd voice-chat-assistant
   ```

3. Install dependencies:
   ```bash
   npm run install-all
   ```

4. Create a `.env` file with your development settings:
   ```
   OPENAI_API_KEY=your_openai_key_here
   PASSWORD=dev_password
   PORT=3001
   FRONTEND_URL=http://localhost:3000
   ```

5. Start the development servers:
   ```bash
   npm run dev
   ```

## Development Environment
* **Backend**: Node.js + TypeScript + Express
* **Frontend**: Vue 3 + Vite + TailwindCSS
* **IDE**: We recommend Visual Studio Code with the following extensions:
   * ESLint
   * Vetur or Volar (for Vue)
   * Tailwind CSS IntelliSense
   * TypeScript Vue Plugin

## Development Workflow
1. Create a feature branch from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and commit them with a meaningful commit message:
   ```bash
   git commit -m "feat: add new feature"
   ```
   We follow Conventional Commits format.

3. Push your changes to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```

4. Submit a pull request to the `main` branch of the original repository.

## Pull Request Process
1. Ensure your PR includes a clear description of the changes and why they're needed.
2. Update documentation as needed.
3. Make sure all tests pass and add new tests for new functionality.
4. The PR will be reviewed by maintainers, who may request changes.
5. Once approved, your PR will be merged.

## Coding Standards

### General
* Use meaningful variable and function names
* Keep functions small and focused on a single task
* Comment complex logic
* Minimize code duplication

### Frontend (Vue)
* Use the Composition API with `<script setup>`
* Follow Vue 3 best practices
* Use TailwindCSS for styling
* Make responsive designs that work on mobile and desktop
* Use TypeScript for type safety

### Backend (Node.js)
* Use TypeScript for all backend code
* Follow RESTful API design principles
* Properly handle errors and return appropriate status codes
* Validate all input data
* Keep controllers thin and move business logic to services

### TypeScript
* Use proper typing, avoid `any` where possible
* Use interfaces for object shapes
* Use meaningful type names

## Testing
We're in the process of adding comprehensive testing. When contributing:
* Add unit tests for new functionality
* Ensure existing tests pass
* Consider edge cases in your tests

## Documentation
Good documentation is crucial for maintainability:
* Update README.md if you add or change functionality
* Document all API endpoints
* Add JSDoc comments to functions and classes
* Update ARCHITECTURE.md for significant changes
* For core packages (`@framers/agentos`) follow enhanced TSDoc standards below.

### AgentOS TSDoc Standards

Public (exported) interfaces, types, and classes MUST include:
1. Purpose summary (one sentence) + high-level role in the system.
2. Parameter docs for all method arguments (especially generics & callbacks).
3. Error Semantics: Enumerate error codes or conditions thrown (link to custom error types where relevant).
4. Streaming Invariants (for any async generators): Define delta structure, terminal chunk rules (`isFinal`), and reconstruction steps.
5. Lifecycle requirements (e.g., initialize() must succeed before use; shutdown() idempotent).
6. Concurrency / cancellation notes if AbortSignals or external interrupts are supported.
7. Examples for complex orchestration flows (PromptEngine.constructPrompt, provider streaming loop).

Minimum Examples:
* A streaming completion loop reconstructing `responseTextDelta` and tool call JSON arguments.
* PromptEngine usage showing contextual elements + token budgeting summary.

Prohibited:
* Placeholder comments like `// TODO: doc` left in exported surfaces.
* Cryptic abbreviations without expansion (expand first occurrence: e.g., GMI = Generalized Mind Instance).

Review Checklist for PRs touching public API:
- [ ] Added/updated TSDoc on new or changed interfaces/classes.
- [ ] Included streaming invariants if async generator added/modified.
- [ ] Updated README migration notes if provider surface altered.
- [ ] Added or updated tests covering new error modes or edge cases.

## Issue Reporting
When reporting issues:
1. Check existing issues to avoid duplicates
2. Use a clear, descriptive title
3. Include:
   * Steps to reproduce
   * Expected behavior
   * Actual behavior
   * Environment details (browser, OS, etc.)
   * Screenshots if applicable

## Feature Requests
For feature requests:
1. Check existing issues/requests first
2. Clearly describe the feature and its use case
3. Explain why it would be valuable to the project
4. Include any relevant mockups or examples

Thank you for contributing to Voice Coding Assistant!

