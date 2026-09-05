# Security Policy

## Supported versions

Security fixes target the latest published GitHub Release. The default branch
and pre-releases receive best-effort fixes; older releases are unsupported
unless a maintainer explicitly states otherwise in their Release notes.

## Reporting a vulnerability

Do not open a public Issue for a vulnerability, leaked credential, private
path, or unredacted workflow. Use GitHub's private vulnerability report:

https://github.com/Lena-centa/Armarius-Arcanorum/security/advisories/new

Include the affected version or commit, operating system, deployment mode,
reproduction steps, impact, and a minimal redacted proof of concept. Remove
API keys, cookies, personal paths, private prompts, images, and database
contents. If private vulnerability reporting is temporarily unavailable,
contact a maintainer privately and share only the minimum information needed
to establish a secure channel.

We will acknowledge reports on a best-effort basis, validate the issue,
coordinate a fix and disclosure window, and credit the reporter if requested.
Please allow time for a patched Release before public disclosure.

## In scope

- Authentication or authorization bypass
- Remote code execution, command injection, path traversal, or arbitrary file access
- Server-side request forgery through remote image or ComfyUI integrations
- Exposure of secrets, private paths, prompts, workflows, images, or database records
- Malicious workflow or image metadata that causes a persistent compromise
- Release or update mechanisms that accept tampered artifacts

Ordinary bugs, unsupported workflow nodes, feature requests, and performance
issues belong in the public Issue tracker. Reports about third-party services
without a demonstrated impact on this project should be sent to the relevant
provider.
