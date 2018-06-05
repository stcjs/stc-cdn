import Plugin from 'stc-plugin';
import path from 'path';

import {
  isRemoteUrl, 
  md5, 
  ResourceRegExp, 
  htmlTagResourceAttrs,
  extend
} from 'stc-helper';

import {
  getCacheHandle
} from './helper.js';

/**
 * upload resource to cdn
 */
export default class CdnPlugin extends Plugin {
  /**
   * run
   */
  async run(){
    if(this.isTpl() || this.prop('isTpl')){
      return this.parseHtml();
    }
    let extname = this.file.extname;
    switch(extname){
      case 'js':
        return this.parseJs();
      case 'css':
        return this.parseCss();
      default:
        let content = await this.getContent('binary');
        let url = await this.getCdnUrl(content, this.file.path);
        return {url};
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
    return {ast: tokens};
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
    return this.asyncReplace(content, ResourceRegExp.cdn, async (a, b, c, d) => {
      let url = await this.getUrlByInvoke(d);
      return `"${url}"`;
    });
  }
  /**
   * parse css
   */
  async parseCss(){
    let sourceTokens = await this.getAst();
    let tokens = this.options.notUpdateResource ? extend([], sourceTokens) : sourceTokens;
    let property = '';
    let promises = tokens.map(token => {
      if(token.type === this.TokenType.CSS_PROPERTY){
        property = token.ext.value.toLowerCase();
      }
      if(token.type !== this.TokenType.CSS_VALUE){
        return;
      }
      if(property){
        let p = property;
        property = '';
        return this.replaceCssResource(token.ext.value, p).then(val => {
          token.ext.value = val;
        });
      }
    });
    await Promise.all(promises);

    // virtual file
    if(this.file.prop('virtual')){
      return tokens;
    }
    this.file.setAst(tokens);
    let content = await this.file.getContent('utf8');
    if(this.options.notUpdateResource){
      this.file.setAst(sourceTokens);
    }
    let url = await this.getCdnUrl(content, this.file.path);
    return {url, ast: tokens};
  }
  /**
   * replace css resource
   */
  replaceCssResource(value, property){
    // ie filter
    if(property === 'filter'){
      return this.asyncReplace(value, ResourceRegExp.filter, async (a, b, p) => {
        if(isRemoteUrl(p)){
          return `src=${b}${p}${b}`;
        }
        let url = await this.getUrlByInvoke(p);
        return `src=${b}${url}${b}`;
      });
    }
    // font-face
    if(property === 'src'){
      return this.asyncReplace(value, ResourceRegExp.font, async (a, b, p, suffix) => {
        if(isRemoteUrl(p)){
          return `url(${p}${suffix})`;
        }
        let url = await this.getUrlByInvoke(p);
        return `url(${url}${suffix})`;
      });
    }
    // background image
    return this.asyncReplace(value, ResourceRegExp.background, async (a, b, p) => {
      if(isRemoteUrl(p)){
        return `url(${p})`;
      }
      let url = await this.getUrlByInvoke(p);
      return `url(${url})`;
    });
  }
  /**
   * get cdn url
   */
  getCdnUrl(content, filepath){
    let adapter = this.options.adapter;
    if(adapter && typeof adapter.default === 'function'){
      adapter = adapter.default;
    }
    if(typeof adapter !== 'function'){
      this.fatal(`${this.contructor.name}: options.adapter must be a function`);
    }
    return this.await(`getCdnUrl${filepath}${JSON.stringify(this.options)}`, () => {
      return adapter(content, filepath, this.options, getCacheHandle(this, content), this);
    })
  }
  /**
   * get url by invoke plugin
   */
  async getUrlByInvoke(filepath){
    let {exclude} = this.options;
    if(exclude && this.stc.resource.match(filepath, exclude)){
      return Promise.resolve(filepath);
    }
    let data = await this.invokeSelf(filepath);
    return data.url;
  }
  /**
   * parse html tag start
   */
  parseHtmlTagStart(token){
    let list = [htmlTagResourceAttrs, this.options.tagAttrs || {}];
    let {attrs, tagLowerCase} = token.ext;
    if (!attrs) {
      throw new Error(`${token.value} is not valid token, file: ${this.file.path}`);
    }
    let promises = list.map(item => {
      let tagAttrs = item[tagLowerCase] || [];
      if(!Array.isArray(tagAttrs)){
        tagAttrs = [tagAttrs];
      }
      let promise = tagAttrs.map(attr => {
        let value = this.stc.flkit.getHtmlAttrValue(attrs, attr);
        if(!value || isRemoteUrl(value)){
          return;
        }

        // ignore link tag when rel value is not stylesheet
        // <link rel="alternate" href="/rss.html">
        if(tagLowerCase === 'link'){
          let rel = this.stc.flkit.getHtmlAttrValue(attrs, 'rel').toLowerCase();
          if(rel !== 'stylesheet' && (this.options.rels || []).indexOf(rel) === -1){
            return;
          }
        }

        // <img src="/static/img/404.jpg" srcset="/static/img/404.jpg 640w 1x, /static/img/404.jpg 2x" />
        if(attr === 'srcset'){
          let values = value.split(',');
          let promises = values.map(item => {
            item = item.trim();
            let items = item.split(' ');
            return this.getUrlByInvoke(items[0].trim()).then(cdnUrl => {
              items[0] = cdnUrl;
              return items.join(' ');
            });
          });
          return Promise.all(promises).then(ret => {
            this.stc.flkit.setHtmlAttrValue(attrs, attr, ret.join(','));
          });
        }

        let extname = path.extname(value);
        // check link resource extname
        // ignore resource when has template syntax
        if(!/^\.\w+$/.test(extname)){
          return;
        }

        return this.getUrlByInvoke(value).then(cdnUrl => {
          this.stc.flkit.setHtmlAttrValue(attrs, attr, cdnUrl);
        });
      });

      // replace image/font in style value
      let stylePromise;
      let value = this.stc.flkit.getHtmlAttrValue(attrs, 'style');
      if(value){
        stylePromise = this.replaceCssResource(value).then(value => {
          this.stc.flkit.setHtmlAttrValue(attrs, 'style', value);
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
    if(start.ext.isTpl){
      let filepath = md5(token.ext.content.value) + '.html';
      let file = await this.addFile(filepath, token.ext.content.ext.tokens, true);
      let ret = await this.invokeSelf(file, {
        isTpl: true
      });
      token.ext.content.ext.tokens = ret.ast;
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
    let filepath = md5(content.value) + '.css';
    let file = await this.addFile(filepath, tokens, true);
    let ret = await this.invokeSelf(file);
    content.ext.tokens = ret;
    return token;
  }
  /**
   * update
   */
  update(data){
    if(this.isTpl()){
      this.setAst(data.ast);
      return;
    }
    if(!this.options.notUpdateResource){
      let extname = this.file.extname;
      switch(extname){
        case 'js':
          this.setContent(data.content);
          break;
        case 'css':
          this.setAst(data.ast);
          break;
      }
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
