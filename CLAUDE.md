# CLAUDE.md

Project conventions for Claude Code. These apply to every session in this
repository.

## Language: code is always English

**The user often writes in Norwegian. Never write code in Norwegian.**

This holds regardless of the language of the request, the conversation, or the
domain. Norwegian in the prompt is not a signal to write Norwegian code — it
never has been and never will be.

English, always:

- identifiers — variables, functions, classes, types, constants, parameters
- file and directory names
- code comments and doc comments
- commit messages, branch names, pull request titles and bodies
- log messages, internal error messages, test names and descriptions
- database schema: table names, column names, index names, migration filenames

Norwegian belongs only where it is *content*, not code:

- text shown to end users in the interface
- clinical and regulatory terms of art with no accurate English equivalent
  (`fødselsnummer`, `HPR-nummer`, `takst`, `nødrett`, `sperring`,
  `tjenstlig behov`, `frikort`, `egenandel`) — keep the Norwegian term where it
  names a legally defined concept, and explain it in an English comment the
  first time it appears
- quotations from Norwegian law, standards or specifications
- user-facing documentation written for a Norwegian audience

**When in doubt, ask.** Do not guess which side of the line something falls on.

### The existing Norwegian code

The code in this repository was originally written with Norwegian identifiers,
filenames, comments and database columns. **Another agent is translating it.**

Do not start that translation, and do not rewrite existing Norwegian code into
English as a side effect of other work, unless the user asks for it in this
session. Write any *new* code in English, and leave the rest alone.

## Domain

Electronic patient record (EPJ) for Norwegian GPs. FHIR R5 on HAPI FHIR,
PostgreSQL, SvelteKit. Multi-tenant: one installation serves several practices.

See `docs/arkitektur.md` for the design, `docs/todo.md` for what is not built
yet, and `docs/apne-punkter.md` for what still needs verifying against a source.
