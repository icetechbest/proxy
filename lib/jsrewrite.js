'use strict';
// تعديل الـ JavaScript: كل مرجع لـ location (و window.location / document.location / top.location) بيتحول لنسخة وهمية
// بترجّع العنوان الحقيقي للموقع (مش عنوان البروكسي) وأي تنقل بيعدي على البروكسي.
// بيستخدم acorn (AST) فمفيش لمس للنصوص والتعليقات والـ regex. لو أي حاجة فشلت بيرجّع الكود الأصلي زي ما هو.
let acorn = null; try { acorn = require('acorn'); } catch {}
const crypto = require('crypto');
const ROOTS = new Set(['window', 'document', 'self', 'top', 'parent', 'globalThis']);
const BARE = '(globalThis.__pxlocation||location)';
const SKIP = new Set(['type', 'start', 'end', 'loc', 'range']);
const cache = new Map();

function parse(src) {
  const o = { ecmaVersion: 'latest', allowReturnOutsideFunction: true, allowHashBang: true, allowAwaitOutsideFunction: true };
  try { return acorn.parse(src, { ...o, sourceType: 'script' }); } catch {}
  try { return acorn.parse(src, { ...o, sourceType: 'module' }); } catch {}
  return null;
}
function patIds(p, out) {
  if (!p) return;
  switch (p.type) {
    case 'Identifier': out.push(p); break;
    case 'ObjectPattern': for (const x of p.properties) patIds(x.type === 'RestElement' ? x.argument : x.value, out); break;
    case 'ArrayPattern': for (const x of p.elements) patIds(x, out); break;
    case 'RestElement': patIds(p.argument, out); break;
    case 'AssignmentPattern': patIds(p.left, out); break;
  }
}
const isLhs = (parent, key) => !!parent && ((parent.type === 'AssignmentExpression' && key === 'left') || parent.type === 'UpdateExpression' ||
  ((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') && key === 'left'));

function rewriteJs(src) {
  if (!acorn || !src || !/\blocation\b/.test(src)) return src;
  const ck = crypto.createHash('sha1').update(src).digest('hex');
  if (cache.has(ck)) return cache.get(ck);
  let out = src;
  try {
    const ast = parse(src);
    if (ast) {
      const edits = []; let bail = false;
      const bind = p => { const ids = []; patIds(p, ids); if (ids.some(i => i.name === 'location')) bail = true; };
      const walk = (n, parent, key) => {
        if (bail || !n || typeof n.type !== 'string') return;
        switch (n.type) {
          case 'VariableDeclarator': bind(n.id); break;
          case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
            if (n.id && n.id.name === 'location') bail = true; n.params.forEach(bind); break;
          case 'CatchClause': bind(n.param); break;
          case 'ClassDeclaration': case 'ClassExpression': if (n.id && n.id.name === 'location') bail = true; break;
          case 'ImportSpecifier': case 'ImportDefaultSpecifier': case 'ImportNamespaceSpecifier': case 'ExportSpecifier':
            if ((n.local && n.local.name === 'location') || (n.exported && n.exported.name === 'location')) bail = true; return;
          case 'LabeledStatement': walk(n.body, n, 'body'); return;
          case 'BreakStatement': case 'ContinueStatement': return;
          case 'MemberExpression':
            if (!n.computed && n.property.name === 'location') {
              const o = n.object, lhs = isLhs(parent, key);
              if (o.type === 'Identifier' && ROOTS.has(o.name)) { const e = `(${o.name}.__pxlocation||${o.name}.location)`; edits.push({ s: n.start, e: n.end, t: lhs ? e + '.href' : e }); return; }
              if (o.type === 'MemberExpression' && !o.computed && o.property.type === 'Identifier' && ROOTS.has(o.property.name)) {
                edits.push({ s: n.property.start, e: n.property.end, t: '__pxlocation' + (lhs ? '.href' : '') }); walk(o, n, 'object'); return;
              }
            }
            walk(n.object, n, 'object'); if (n.computed) walk(n.property, n, 'property'); return;
          case 'Property':
            if (!n.computed && n.key.type === 'Identifier' && n.key.name === 'location') {
              if (n.shorthand) { if (parent && parent.type === 'ObjectPattern') bail = true; else edits.push({ s: n.start, e: n.end, t: 'location:' + BARE }); return; }
              walk(n.value, n, 'value'); return;       // {location: x} -> اسم الخاصية بس، مايتلمسش
            }
            if (n.computed) walk(n.key, n, 'key'); walk(n.value, n, 'value'); return;
          case 'MethodDefinition': case 'PropertyDefinition':
            if (n.computed) walk(n.key, n, 'key'); walk(n.value, n, 'value'); return;
          case 'Identifier':
            if (n.name === 'location') edits.push({ s: n.start, e: n.end, t: isLhs(parent, key) ? BARE + '.href' : BARE });
            return;
        }
        for (const k in n) {
          if (SKIP.has(k)) continue; const v = n[k];
          if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walk(c, n, k); }
          else if (v && typeof v.type === 'string') walk(v, n, k);
        }
      };
      walk(ast, null, '');
      if (!bail && edits.length) {
        edits.sort((a, b) => b.s - a.s);
        for (const e of edits) out = out.slice(0, e.s) + e.t + out.slice(e.e);
      }
    }
  } catch { out = src; }
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(ck, out);
  return out;
}
module.exports = { rewriteJs, jsAvailable: !!acorn };
