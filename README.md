# stc-cdn
Upload resource to cdn for stc

## Install

```sh
npm install stc-cdn
```

## How to use

```js
// stc.config.js

var cdn = require('stc-cdn');
var cdnAdapter = require('stc-cdn-xxx');

stc.workflow({
  cdn: {plugin: cdn, options: {adapter: cdnAdapter}}
});
```

## Adapter introduction

adapter code like this: 

```js
export default function stcAdapter(content, filepath, cacheInstance){
  let value = await cacheInstance.get();
  if(value !== undefined){
    return value;
  }
  value = await getCdnUrl(content);
  await cacheInstance.set(value);
  return value;
}
```

## Adapter list
