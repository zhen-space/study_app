import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.mjs';

const json = async response => ({ status: response.status, body: await response.json() });

test('教材編輯器兩個 POST 端點接受 client_request_id 並安全 replay', async () => {
  const server = await startServer();
  const post = (path, body, headers = server.H) => fetch(server.base + path, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  try {
    const book = await json(await post('/material/books', { title: 'API 冪等教材' }));
    assert.equal(book.status, 201);
    const nodeKey = 'material_api_node_key_0001';
    const nodeBody = {
      book_id: book.body.id, kind: 'chapter', title: '第一章', client_request_id: nodeKey,
    };
    const nodeFirst = await json(await post('/material/nodes', nodeBody));
    const nodeReplay = await json(await post('/material/nodes', nodeBody));
    assert.equal(nodeFirst.status, 201);
    assert.equal(nodeReplay.status, 201);
    assert.equal(nodeReplay.body.id, nodeFirst.body.id);

    const itemKey = 'material_api_item_key_0001';
    const itemBody = {
      node_id: nodeFirst.body.id, kind: 'unit_exercise', title: '單元練習',
      client_request_id: itemKey,
    };
    const itemFirst = await json(await post('/material/content-items', itemBody));
    const itemReplay = await json(await post('/material/content-items', itemBody));
    assert.equal(itemFirst.status, 201);
    assert.equal(itemReplay.status, 201);
    assert.equal(itemReplay.body.id, itemFirst.body.id);

    const conflict = await json(await post('/material/content-items', { ...itemBody, title: '偷換內容' }));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'IDEMPOTENCY_KEY_REUSED');
  } finally {
    await server.stop();
  }
});
