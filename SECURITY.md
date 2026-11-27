# Reporting a security issue

Use a private route for a suspected vulnerability, such as unintended disclosure of credentials or private project data, or an action that bypasses an intended permission boundary. Ordinary setup questions, feature requests and bugs without a security impact belong in [GitHub Issues](https://github.com/r-spring/wyarden/issues).

## Find a private reporting route

Use the repository's [private vulnerability reporting form](https://github.com/r-spring/wyarden/security/advisories/new). GitHub explains the workflow in its [private vulnerability reporting guide](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

If the private form is unavailable, use a private security contact listed by the maintainers. You can also open a [public issue](https://github.com/r-spring/wyarden/issues) asking how to contact the maintainers privately. Keep all vulnerability details and logs in the private conversation.

## What to send privately

- A short description of the suspected issue and its impact.
- The affected Wyarden version or source revision, operating system, editor, Claude Code version, and transcript or collector mode.
- Minimal reproduction steps using a disposable repository and synthetic data; include expected and actual behavior.
- Sanitized evidence sufficient to reproduce the issue. Remove credentials, personal data, private source and unrelated prompts or transcripts.

Test only systems and data you are authorized to use. Keep vulnerability details in the private conversation while reporting and discussing a fix.

This policy does not promise a response deadline, a fix schedule or security support for particular versions. Include the affected version in every report so the maintainers can assess it.
