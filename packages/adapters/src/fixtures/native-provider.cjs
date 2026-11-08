// Offline protocol peer for conformance: no provider network requests or credentials.
const readline = require('node:readline');
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const write = (value) => process.stdout.write(JSON.stringify(value) + '\n');
if (args[0] === 'auth') { write({ loggedIn: true, authMethod: 'fixture', email: 'fixture@example.invalid' }); process.exit(0); }
const acp = args.includes('--acp');
let session = acp ? 'fixture-acp-session' : args[args.indexOf(args.includes('--session-id') ? '--session-id' : '--resume') + 1];
let prompt = '', mcpServers = [], toolCall;
const final = () => {
  if (acp) {
    for (const text of prompt.includes('linked-output') ? ['[Report](<rep', 'ort.txt>)'] : ['fixture complete'])
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: session, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
    write({ jsonrpc: '2.0', id: toolCall, result: { stopReason: 'end_turn' } });
  } else {
    write({ type: 'stream_event', session_id: session, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'fixture complete' } } });
    write({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text: 'fixture complete' }] } });
    write({ type: 'result', session_id: session, subtype: 'success', usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 1 } });
  }
};
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
 const m = JSON.parse(line);
 if (acp) {
   const reply = (result) => write({ jsonrpc: '2.0', id: m.id, result });
   if (m.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { loadSession: !args.includes("--no-resume"), promptCapabilities: { image: true }, mcpCapabilities: { http: true }, sessionCapabilities: { close: {} } }, authMethods: [] });
   if (m.method === 'session/new' || m.method === 'session/load') { mcpServers = m.params.mcpServers; reply(m.method === 'session/new' ? { sessionId: session } : {}); }
   if (m.method === 'session/close') reply({});
   if (m.method === 'session/prompt') {
     toolCall = m.id; prompt = m.params.prompt.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
     if (prompt.includes('hang')) { setTimeout(() => fs.writeFileSync(path.join(process.cwd(), 'late-marker'), 'unsafe'), 1200); return; }
     if (prompt.includes('application-tool')) {
       const server = mcpServers[0];
       const result = await fetch(server.url, { method: 'POST', headers: { ...Object.fromEntries(server.headers.map((h) => [h.name, h.value])), 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'test_tool', arguments: { value: 7 } } }) }).then((r) => r.json());
       if (result.result?.content?.[0]?.text !== 'tool result') throw new Error('bad MCP response');
       final();
     } else write({ jsonrpc: '2.0', id: 'permission', method: 'session/request_permission', params: { sessionId: session, toolCall: { toolCallId: 'command', title: 'Write fixture file', rawInput: { command: 'echo fixture' } }, options: [{ kind: 'allow_once', optionId: 'allow-once' }, { kind: 'reject_once', optionId: 'reject-once' }, { kind: 'allow_always', optionId: 'allow-all' }] } });
   }
   if (m.id === 'permission' && m.result) { if (!['allow-once', 'reject-once'].includes(m.result.outcome.optionId)) throw new Error('bad permission response'); final(); }
 } else {
   if (m.type === 'control_request') write({ type: 'control_response', response: { request_id: m.request_id, subtype: 'success', response: {} } });
   if (m.type === 'user') {
     prompt = m.message.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
     if (prompt.includes('hang')) { setTimeout(() => fs.writeFileSync(path.join(process.cwd(), 'late-marker'), 'unsafe'), 1200); return; }
     if (prompt.includes('application-tool')) write({ type: 'control_request', request_id: 'mcp-tool', request: { subtype: 'mcp_message', server_name: 'rakazo', message: { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'test_tool', arguments: { value: 7 } } } } });
     else write({ type: 'control_request', request_id: 'permission', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'echo fixture' }, tool_use_id: 'command' } });
   }
   if (m.type === 'control_response') {
     if (m.response.request_id === 'mcp-tool' && m.response.response.mcp_response.result.content[0].text !== 'tool result') throw new Error('bad MCP reply');
     if (m.response.request_id === 'permission' && !['allow', 'deny'].includes(m.response.response.behavior)) throw new Error('bad permission reply');
     final();
   }
 }
});
