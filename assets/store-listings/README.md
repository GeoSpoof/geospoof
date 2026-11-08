# Store listings

Listing copy and images for the Chrome Web Store (CWS), addons.mozilla.org (AMO) and
the App Store.

- `listing-copy.md` is the English source: the CWS and AMO detailed descriptions, the
  field-by-field notes on where each store field comes from, and the App Store ASO
  reasoning.
- `listing-copy.<locale>.md` holds the translated CWS and AMO detailed descriptions,
  one file per UI language in `_locales/`. Section (a) is the CWS text and section (b)
  is the AMO text.
- `appstore/`, `chrome/`, `promo/` and `github/` hold images and the App Store
  screenshot copy.

## Pasting the detailed descriptions

The CWS Developer Dashboard and the AMO Developer Hub have no API or manifest field for
the detailed description, so it's pasted by hand, one language at a time. In each
section, copy from the 🛡️ line through the last link, and leave out the heading and
any English note above the 🛡️ line.

- **CWS:** Store listing tab, pick the language in the language menu, and paste into
  "Description". The text is plain; emoji and line breaks are kept. The limit is
  16,000 characters.
- **AMO:** Edit Product Page, switch the locale at the top, and paste into
  "Description". AMO renders Markdown, not HTML, and has no headings.

The CWS title and short description come from the literal English strings in
`src/build/manifest.ts`, chosen for store search, so every CWS language shows the
English title. The AMO name and summary come from `_locales/<locale>/messages.json`
and update with the next uploaded version.

| File                    | CWS listing language | AMO locale |
| ----------------------- | -------------------- | ---------- |
| `listing-copy.md`       | English              | en-US      |
| `listing-copy.de.md`    | German               | de         |
| `listing-copy.es.md`    | Spanish              | es-ES      |
| `listing-copy.fr.md`    | French               | fr         |
| `listing-copy.id.md`    | Indonesian           | id         |
| `listing-copy.ja.md`    | Japanese             | ja         |
| `listing-copy.nl.md`    | Dutch                | nl         |
| `listing-copy.pt-BR.md` | Portuguese (Brazil)  | pt-BR      |
| `listing-copy.ru.md`    | Russian              | ru         |
| `listing-copy.sv.md`    | Swedish              | sv-SE      |
| `listing-copy.vi.md`    | Vietnamese           | vi         |
| `listing-copy.zh-CN.md` | Chinese (China)      | zh-CN      |
| `listing-copy.zh-TW.md` | Chinese (Taiwan)     | zh-TW      |

Every translation was written from the English and still needs review by a native
speaker. When the English changes, update every translation in the same commit.

`tests/unit/store-listings.unit.test.ts` fails when a UI locale in `_locales/` has no
listing file, or when a CWS detailed description reaches 16,000 characters.
