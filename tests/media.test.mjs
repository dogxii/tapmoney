import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { allowedImage, cacheMedia } from '../scripts/media.mjs';
import { extractGameMetadata } from '../shared/catalog.mjs';
import { mediaUrl } from '../shared/media.mjs';

test('公开截图解析兼容字符串与 ImageObject，去重并拒绝危险链接', () => {
  const html='<script type="application/ld+json">{"@type":"VideoGame","image":"https://img-tc.tapimg.com/logo.png","screenshot":[{"url":"https://img-tc.tapimg.com/shot.jpg"},"https://img-tc.tapimg.com/shot.jpg",{"url":"javascript:bad"}]}</script>';
  assert.deepEqual(extractGameMetadata('1',html).media,[{kind:'logo',url:'https://img-tc.tapimg.com/logo.png'},{kind:'screenshot',url:'https://img-tc.tapimg.com/shot.jpg'}]);
  assert.equal(allowedImage('https://q1.qlogo.cn/g?b=qq&nk=12345678&s=100'),true);
  assert.equal(allowedImage('https://tapimg.com.evil.example/pic.png'),false);
  assert.equal(allowedImage('http://127.0.0.1/secret'),false);
  assert.equal(mediaUrl('/media/../../secret'),null);
});

test('QQ 图片缓存为同源静态文件，不携带登录凭证，跳转域名受限', async t => {
  const directory=await mkdtemp(path.join(tmpdir(),'tapmoney-media-')); t.after(()=>rm(directory,{recursive:true,force:true}));
  const source='https://q1.qlogo.cn/g?b=qq&nk=12345678&s=100';
  const bytes=new Uint8Array([137,80,78,71,13,10,26,10]);
  const catalog={games:{},authors:[{id:'maker',avatarUrl:source}]};
  const result=await cacheMedia(catalog,{directory,request:async (url,init)=>{assert.equal(url,source);assert.equal(init.headers.Cookie,undefined);assert.equal(init.redirect,'manual');return new Response(bytes,{headers:{'Content-Type':'image/png'}});}});
  const local=result.authors[0].avatarUrl;
  assert.match(local,/^\/media\/[a-f0-9]{64}\.png$/);
  assert.equal(result.authors[0].avatarSourceUrl,source);
  assert.deepEqual(new Uint8Array(await readFile(path.join(directory,local.split('/').at(-1)))),bytes);
  const blocked={games:{},authors:[{avatarUrl:'https://q1.qlogo.cn/g?b=qq&nk=99999&s=100'}]};
  let calls=0;
  await cacheMedia(blocked,{directory,request:async()=>{calls++;return new Response('',{status:302,headers:{Location:'https://other.example/image.png'}});}});
  assert.equal(calls,1);
  assert.ok(blocked.authors[0].avatarUrl.startsWith('https://q1.qlogo.cn/'));
  assert.deepEqual(await readdir(directory),[]);
});
