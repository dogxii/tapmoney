import test from 'node:test';
import assert from 'node:assert/strict';
import { extractGameMetadata } from '../shared/catalog.mjs';
import { mediaUrl } from '../shared/media.mjs';

test('公开截图解析兼容字符串与 ImageObject，去重并拒绝危险链接', () => {
  const html='<script type="application/ld+json">{"@type":"VideoGame","image":"https://img-tc.tapimg.com/logo.png","screenshot":[{"url":"https://img-tc.tapimg.com/shot.jpg"},"https://img-tc.tapimg.com/shot.jpg",{"url":"javascript:bad"}]}</script>';
  assert.deepEqual(extractGameMetadata('1',html).media,[{kind:'logo',url:'https://img-tc.tapimg.com/logo.png'},{kind:'screenshot',url:'https://img-tc.tapimg.com/shot.jpg'}]);
  assert.equal(mediaUrl('/media/../../secret'),null);
});
