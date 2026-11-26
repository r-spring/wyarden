# Reporting a security issue

Use a private route for a suspected vulnerability, such as unintended disclosure of credentials or private project data, or an action that bypasses an intended permission boundary. Ordinary setup questions, feature requests and bugs without a security impact belong in [GitHub Issues](https://github.com/r-spring/wyarden/issues).

## Find a private reporting route

If [this repository's security area](https://github.com/r-spring/wyarden/security) offers **Report a vulnerability**, use that private form. Its availability depends on the repository settings; this document does not enable the feature. GitHub explains the workflow in its [private vulnerability reporting guide](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately).

If the private form is unavailable, use a private security contact explicitly listed by the maintainers. If none is listed, and [[public issues](https://github.com/r-spring/wyarden/issues)](https://github.com/r-spring/wyarden/issues) are available, open an issue asking only: "How can I contact the maintainers privately about a security issue?" Do not include the affected component, exploit, logs or other vulnerability details in that public request. If neither route is available, retain the details until a private route is provided.

## What to send privately

- A short description of the suspected issue and its impact.
- The affected Entomatical version or source revision, operating system, editor and relevant provider/CLI version.
- Minimal reproduction steps using a disposable repository and synthetic data; include expected and actual behavior.
- Sanitized evidence sufficient to reproduce the issue. Remove credentials, personal data, private source and unrelated prompts or transcripts.

Test only systems and data you are authorized to use. Keep vulnerability details in the private conversation while reporting and discussing a fix.

This policy does not promise a response deadline, a fix schedule or security support for particular versions. Include the affected version in every report so the maintainers can assess it.
