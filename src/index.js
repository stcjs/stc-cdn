import Plugin from 'stc-plugin';
import {isRemoteUrl, isBuffer, md5} from 'stc-helper';
import path from 'path';

/**
 * resouce attrs
 */
const defaultResourceAttrs = {
  img: ['src', 'srcset'],
  script: ['src'],
  link: ['href'],
  param: ['value'],
  embed: ['src'],
  object: ['data'],
  source: ['src', 'srcset']
};

const backgroundRegExp = /url\s*\(\s*([\'\"]?)([\w\-\/\.\@]+\.(?:png|jpg|gif|jpeg|ico|cur|webp))(?:\?[^\?\'\"\)\s]*)?\1\s*\)/ig;
const fontRegExp = /url\s*\(\s*([\'\"]?)([^\'\"\?]+\.(?:eot|woff|woff2|ttf|svg))([^\s\)\'\"]*)\1\s*\)/ig;
const filterRegExp = /src\s*=\s*([\'\"])?([^\'\"]+\.(?:png|jpg|gif|jpeg|ico|cur|webp))(?:\?[^\?\'\"\)\s]*)?\1\s*/ig;
const jsStcRegexp = /\{\s*([\'\"]?)cdn\1\s*\:\s*([\'\"])([\w\/\-\.]+)\2\s*\}\.cdn/gi;

/**
 * upload resource to cdn
 */
export default class CdnPlugin extends Plugin {
  /**
   * run
   */
  async run(){
    if(this.file.prop('tpl')){
      return this.parseHtml();
    }
    let extname = this.file.extname;
    switch(extname){
      case 'js':
        return this.parseJs();
      case 'css':
        return this.parseCss();
      default:
        let buffer = await this.getContent();
        return this.getCdnUrl(buffer, this.file.path);
    }
  }
  /**
   * parse html
   */
  async parseHtml(){
    let tokens = await this.getAst();
    let promises = tokens.map(token => {
      switch(token.type){
        case this.TokenType.HTML_TAG_START:
          return this.parseHtmlTagStart(token);
        case this.TokenType.HTML_TAG_SCRIPT:
          return this.parseHtmlTagScript(token);
        case this.TokenType.HTML_TAG_STYLE:
          return this.parseHtmlTagStyle(token);
      }
    });
    await Promise.all(promises);
    return tokens;
  }
  /**
   * parse js
   */
  async parseJs(){
    let content = await this.getContent('utf8');
    content = await this.parseJsResource(content);
    let url = await this.getCdnUrl(content, this.file.path);
    return {url, content};
  }
  /**
   * parse js resource
   * {cdn: "path/to/resource"}.cdn
   */
  parseJsResource(content){
    return this.asyncReplace(content, jsStcRegexp, async (a, b, c, d) => {
      let url = await this.invokeSelf(d);
      return `"${url}"`;
    });
  }
  /**
   * parse css
   */
  async parseCss(){
    let tokens = await this.getAst();
    let property = '';
    let promises = tokens.map(async (token) => {
      if(token.type === this.TokenType.CSS_PROPERTY){
        property = token.ext.value.toLowerCase();
      }
      if(token.type !== this.TokenType.CSS_VALUE){
        return;
      }
      if(property){
        token.ext.value = await this.replaceCssResource(token.ext.value, property);
        property = '';
      }
    });
    await Promise.all(promises);
   

    // virtual file
    if(this.file.prop('virtual')){
      return tokens;
    }
    this.file.setAst(tokens);
    let content = await this.file.getContent('utf8');
    let url = await this.getCdnUrl(content, this.file.path);
    return {url, ast: tokens};
  }
  /**
   * replace css resource
   */
  replaceCssResource(value, property){
    // ie filter
    if(property === 'filter'){
      return this.asyncReplace(value, filterRegExp, async (a, b, p) => {
        if(isRemoteUrl(p)){
          return `src=${b}${p}${b}`;
        }
        let url = await this.invokeSelf(p);
        return `src=${b}${url}${b}`;
      });
    }
    // font-face
    if(property === 'src'){
      return this.asyncReplace(value, fontRegExp, async (a, b, p, suffix) => {
        if(isRemoteUrl(p)){
          return `url(${p}${suffix})`;
        }
        let url = await this.invokeSelf(p);
        return `url(${url}${suffix})`;
      });
    }
    // background image
    return this.asyncReplace(value, backgroundRegExp, async (a, b, p) => {
      if(isRemoteUrl(p)){
        return `url(${p})`;
      }
      let url = await this.invokeSelf(p);
      return `url(${url})`;
    });
  }

  /**
   * get cache instance
   */
  getCacheInstance(){
    let cacheKey = (this.config.product || 'default') + '/cdn';
    let cacheInstances = this.stc.cacheInstances;
    if(cacheInstances[cacheKey]){
      return cacheInstances[cacheKey];
    }
    cacheInstances[cacheKey] = new this.stc.cache({
      type: cacheKey
    });
    return cacheInstances[cacheKey];
  }
  /**
   * get cdn url
   */
  getCdnUrl(buffer, filepath){
    let content = isBuffer(buffer) ? buffer.toString() : buffer;
    let adapter = this.options.adapter;
    if(adapter && typeof adapter.default === 'function'){
      adapter = adapter.default;
    }
    if(typeof adapter !== 'function'){
      this.fatal(`${this.contructor.name}: options.adapter must be a function`);
    }
    let cacheInstance = this.getCacheInstance();
    let cacheKey = md5(content);
    return adapter(buffer, filepath, this.options, {
      get: () => {
        return cacheInstance.get(cacheKey);
      },
      set: data => {
        return cacheInstance.set(cacheKey, data);
      }
    });
  }
  /**
   * parse html tag start
   */
  parseHtmlTagStart(token){
    let list = [defaultResourceAttrs, this.options.tagAttrs || {}];
    let {attrs, tagLowerCase} = token.ext;
    let promises = list.map(item => {
      if(!item[tagLowerCase]){
        return;
      }
      let tagAttrs = item[tagLowerCase];
      if(!Array.isArray(tagAttrs)){
        tagAttrs = [tagAttrs];
      }
      let promise = tagAttrs.map(attr => {
        let value = this.stc.flkit.getHtmlAttrValue(attrs, attr);
        if(!value || isRemoteUrl(value)){
          return;
        }
        let extname = path.extname(value);
        // check link resource extname
        // ignore resource when has template syntax
        if(!/^\.\w+$/.test(extname)){
          return;
        }
        // <img src="/static/img/404.jpg" srcset="/static/img/404.jpg 640w 1x, /static/img/404.jpg 2x" />
        if(attr === 'srcset'){
          let values = value.split(',');
          let promises = values.map(item => {
            item = item.trim();
            let items = item.split(' ');
            return this.invokeSelf(items[0].trim()).then(cdnUrl => {
              items[0] = cdnUrl;
              return items.join(' ');
            });
          });
          return Promise.all(promises).then(ret => {
            this.stc.flkit.setHtmlAttrValue(attrs, attr, ret.join(','));
          });
        }else{
          return this.invokeSelf(value).then(cdnUrl => {
            this.stc.flkit.setHtmlAttrValue(attrs, attr, cdnUrl);
          });
        }
      });

      // replace image/font in style value
      let stylePromise;
      let value = this.stc.flkit.getHtmlAttrValue(attrs, 'style');
      if(value){
       stylePromise = this.replaceCssResource(value).then(value => {
         this.set.flkit.setHtmlAttrValue(attrs, 'style', value);
       });
      }
      return Promise.all([Promise.all(promise), stylePromise]);
    });
    return Promise.all(promises).then(() => {
      return token;
    });
  }
  /**
   * parse script tag
   */
  async parseHtmlTagScript(token){
    let start = token.ext.start;
    if(start.ext.isExternal){
      token.ext.start = await this.parseHtmlTagStart(start);
      return token;
    }
    let content = token.ext.content;
    content.value = await this.parseJsResource(content.value);
    return token;
  }
  /**
   * parse style tag
   */
  async parseHtmlTagStyle(token){
    let content = token.ext.content;
    let tokens = content.ext.tokens || content.value;
    let filepath = '/stc/' + md5(content.value) + '.css';
    let file = await this.addFile(filepath, tokens, true);
    let ret = await this.invokeSelf(file);
    content.ext.tokens = ret;
    return token;
  }
  /**
   * update
   */
  update(data){
    if(this.file.prop('tpl')){
      this.setAst(data);
      return;
    }
    let extname = this.file.extname;
    switch(extname){
      case 'js':
        this.setContent(data.content);
        return data.url;
      case 'css':
        // virtual file
        if(this.file.prop('virtual')){
          return data;
        }
        this.setAst(data.ast);
        return data.url;
    }
  }
  /**
   * default include
   */
  static include(){
    return {type: 'tpl'};
  }
  /**
   * use cluster
   */
  static cluster(){
    return false;
  }
  /**
   * close cache
   */
  static cache(){
    return false;
  }
}