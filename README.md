# Discord Bot Project Layout

## Structure

```
discord-bot/
├── index.js                          # App entrypoint
├── src/
│   ├── bot/
│   │   ├── runtime.js                # Discord client runtime + command handlers
│   │   └── notificationTemplates.js  # Template parser/renderer
│   ├── config/
│   │   └── index.js                  # Env loading and config object
│   ├── services/
│   │   ├── payhipService.js          # Payhip/purchase + webhook business logic
│   │   └── supportApi.js             # Support API client wrappers
│   └── storage/
│       ├── db.js                     # MySQL setup + schema helpers
│       └── store.js                  # Local JSON purchase store/cache
├── scripts/
│   └── payhip/
│       └── import-purchases.js       # One-off import tool
└── data/
    ├── templates/
    │   └── discord-notifications.jsons
    └── store.json
```

## Commands

- `npm start`
- `npm run import-purchases`

## Notes

- `src/config/index.js` supports both `env` and `.env`.
- Notification templates are read from `data/templates/discord-notifications.jsons`.
- Legacy template paths are still supported for compatibility.
