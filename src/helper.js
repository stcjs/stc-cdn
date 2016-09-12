import {md5} from 'stc-helper';

/**
 * default instance
 */
const defaultInstance = {
  get: () => {},
  set: () => {}
};

/**
 * get cache instance
 */
export const getCacheInstance = instance => {
  let cacheKey = (instance.config.product || 'default') + '/cdn';
  let cacheInstances = instance.stc.cacheInstances;
  if(cacheInstances[cacheKey]){
    return cacheInstances[cacheKey];
  }
  cacheInstances[cacheKey] = new instance.stc.cache({
    path: instance.stc.config.cachePath,
    type: cacheKey
  });
  return cacheInstances[cacheKey];
};

/**
 * get cache handle
 */
export const getCacheHandle = (instance, content) => {
  if(instance.config.cache === false){
    return defaultInstance;
  }
  let cacheInstance = getCacheInstance(instance);
  let cacheKey = md5(content);
  return {
    get: () => {
      return cacheInstance.get(cacheKey);
    },
    set: data => {
      return cacheInstance.set(cacheKey, data);
    }
  };
};