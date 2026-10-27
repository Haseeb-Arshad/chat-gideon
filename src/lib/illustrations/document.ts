import kitSource from './vendor/iso-kit.txt?raw'
import { readIllustrationHtml } from './validation'

const escape = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const inline = (source: string) => source.replace(/<\/script/gi, '<\\/script')
const api = [...kitSource.matchAll(/^export (?:const|function) (\w+)/gm)].map(match => match[1])
const kit = `window.Anatomy=(()=>{${kitSource.replace(/^export /gm, '')}
function renderSolids(paths,style){return Array.isArray(paths)?paths.map(p=>renderSolids(p,style)).join(''):solidSvg(paths,style)}
return {${api.map(name => name === 'solidSvg' ? 'solidSvg:renderSolids' : name).join(',')}};})();`

/** No host fonts, tokens or scripts enter this document. Export uses the same boundary. */
export function illustrationDocument(html: string, title: string, channel = ''): string {
  const checked = readIllustrationHtml(html)
  if (!checked) throw new Error('Invalid illustration document')
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escape(title)}</title><style>html,body{margin:0;min-height:100%;background:#f8f7f3;color:#242522;font-family:system-ui,sans-serif}*{box-sizing:border-box}svg,canvas{max-width:100%}button,input{font:inherit}:focus-visible{outline:2px solid #267560;outline-offset:3px}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}</style>
<script>${inline(kit)}
document.head.insertAdjacentHTML('beforeend','<style>'+Anatomy.ISO_CSS.replace('.iso[data-theme="light"]','.iso:not([data-theme="dark"])')+'</style>');
const channel=${JSON.stringify(channel)};let failed=false;
function report(state,detail=''){parent.postMessage({type:'gideon-illustration',channel,state,detail:String(detail).slice(0,300)},'*')}
addEventListener('error',event=>{failed=true;report('error',event.message)});
addEventListener('unhandledrejection',event=>{failed=true;report('error',event.reason?.message||'Unhandled drawing error')});
addEventListener('load',()=>{if(!failed)report(document.querySelector('svg,canvas')?'ready':'error')});
</script></head><body>${checked}</body></html>`
}

/**
 * The frame a drawing is watched in while it is still being written.
 *
 * It is one document that never reloads: the host sends it the markup so far
 * and it swaps it in, so the drawing grows in place instead of flashing at
 * every update. Nothing the model wrote can run here. The only script is this
 * one, allowed by a nonce, and the markup it receives is parsed inert, stripped
 * of scripts, handlers and anything that loads, and only then put on the page.
 */
export function draftDocument(channel: string, nonce: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<style>html,body{margin:0;min-height:100%;background:#f8f7f3;color:#242522;font-family:system-ui,sans-serif}*{box-sizing:border-box}svg,canvas{max-width:100%}button,input{font:inherit}</style>
</head><body><script nonce="${nonce}">
const channel=${JSON.stringify(channel)};
const drop='script,iframe,frame,object,embed,link,meta,base,form,audio,video,source,track';
addEventListener('message',event=>{
  if(event.source!==parent||event.data?.type!=='gideon-draft'||event.data.channel!==channel||typeof event.data.html!=='string')return;
  const page=new DOMParser().parseFromString('<!doctype html><body>'+event.data.html,'text/html');
  page.querySelectorAll(drop).forEach(node=>node.remove());
  page.body.querySelectorAll('*').forEach(node=>{for(const attribute of [...node.attributes]){if(/^on/i.test(attribute.name)||/^\s*javascript:/i.test(attribute.value)||(/^\s*data:/i.test(attribute.value)&&attribute.name!=='src'))node.removeAttribute(attribute.name)}});
  document.body.replaceChildren(...document.adoptNode(page.body).childNodes);
});
parent.postMessage({type:'gideon-draft-ready',channel},'*');
</script></body></html>`
}
