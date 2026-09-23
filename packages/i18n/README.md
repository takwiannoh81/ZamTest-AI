# @zamtest/i18n

Translations for the Portal, the Designer and the action catalog.

- `src/locales/en.ts` holds the English UI strings. It is the source of truth.
- `src/locales/<code>.ts` holds one bundle per language: `{ ui, catalog }`.
  - The compiler rejects a bundle whose `ui` is missing a key.
  - `catalog` covers action names, descriptions, categories and property labels. Its keys come from `catalogSource()`, which is built from `BUILTIN_ACTIONS`.
- `src/react.tsx` provides `I18nProvider`, `useI18n()` and `<LanguageSelect/>`. Languages are loaded lazily, so each app downloads only the one in use. Any missing string falls back to English.

## Adding or changing strings

1. Add the English text to `en.ts` (for UI strings) or to the action's metadata in `packages/core/src/catalog.ts` (for catalog strings).
2. Add the translation to every locale file.
3. Run `pnpm test`. `test/locales.test.ts` fails if any language is missing a string, has an extra key, or changes a `{placeholder}`.

## Adding a language

1. Add it to `LOCALES` in `src/locales.ts`.
2. Create `src/locales/<code>.ts` by copying an existing bundle.
3. Register its loader in `src/loaders.ts`.
4. Run `pnpm test`.

The translations were machine-assisted. Please have a native speaker review them before a customer launch, especially Thai, Afrikaans and Swahili.
