# Contributing to somora

Contributions are welcome: bug reports, ideas, documentation fixes and
code. somora is a small project, so a few rules keep things easy.

## Questions, bugs and ideas

- **Questions** and quick help: [Discord](https://somora.ai/discord).
- **Bugs and ideas:** [open an issue](https://github.com/thenaxon/somora_agent/issues/new/choose).
  Search first, someone may have reported it already.
- **Security problems:** never as an issue. Report them privately, as
  [SECURITY.md](.github/SECURITY.md) describes.

Issues labelled
[good first issue](https://github.com/thenaxon/somora_agent/labels/good%20first%20issue)
or
[help wanted](https://github.com/thenaxon/somora_agent/labels/help%20wanted)
are a good place to start.

## Pull requests

1. For anything larger than a small fix, open an issue first and say
   what you plan. That saves you work on something that does not fit.
2. Set up a checkout as
   [docs/setup.md → Develop from a checkout](docs/setup.md#develop-from-a-checkout)
   describes. Use a scratch `SOMORA_HOME` so your own install stays
   untouched.
3. Keep a PR to one topic. Write tests next to the code
   (`*.test.mts`).
4. Run `npm run verify:fast` before you push. It runs the typecheck and
   every test.
5. When behaviour changes, update the page in `docs/`. The docs are
   published at [docs.somora.ai](https://docs.somora.ai).

What we look for:

- All text a user sees (UI, errors, CLI output) is in English.
- New settings go into `config.yaml`, with a default, not into
  environment variables.
- No keys, tokens, host names, IP addresses or real names in code,
  tests or docs. Use placeholders such as `<your-agent>`.
- Do not change the version number. Versions are set at release time
  (`YYYY.MDD.N`, a date and a counter).

## License

By contributing you agree that your work is published under the
[MIT license](LICENSE).
