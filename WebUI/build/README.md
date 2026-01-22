# Installer Build

## Fetch remote dependencies for build

1. run `npm install`
2. run `npm run fetch-build-resources`

## decide for offline or online installer

### online installer

run

```
npm run prepare-build
npm run build
```

### offline installer

**FIXME: offline scripts are missing**

run

```
npm run prepare-build:${PLATFORM}-offline
npm run build:${PLATFORM}-offline
```

Fetching, installing and compressing the full python dependencies takes a considerable amount of time.
