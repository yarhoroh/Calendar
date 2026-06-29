import { BrowserWindow } from 'electron'

// Background article fetcher for the AI's readUrl tool. Loads a URL in a HIDDEN window that
// shares the internal browser's logged-in session (persist:mailbrowser), so paywalls/logins
// (Medium, etc.) pass just like in the visible browser. Waits for the DOM to settle, then
// pulls out the readable article text (no HTML) and throws the window away. Returns plain
// text the model can translate / summarize / read aloud.

// resolve once the DOM stops mutating for 500ms (SPA/lazy content in place), 8s hard cap
const WAIT_READY = `new Promise(function(resolve){
  var done=false;
  function finish(){ if(done)return; done=true; try{obs.disconnect()}catch(e){} resolve(true) }
  var idle=setTimeout(finish,500);
  var obs=new MutationObserver(function(){ clearTimeout(idle); idle=setTimeout(finish,500) });
  try{ obs.observe(document.body,{childList:true,subtree:true,characterData:true}) }catch(e){ return finish() }
  setTimeout(finish,8000);
})`

// pull the main article's text: prefer <article>/<main>, take block elements, skip chrome
const EXTRACT = `(function(){
  function txt(el){
    var w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),n,s='';
    while((n=w.nextNode())){
      var p=n.parentElement;
      if(p&&p.closest('script,style,noscript,svg,code,pre,textarea'))continue;
      s+=(n.nodeValue||'');
    }
    return s.replace(/\\s+/g,' ').trim();
  }
  var root=document.querySelector('article')||document.querySelector('main')||document.body;
  var parts=[];
  root.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,figcaption').forEach(function(el){
    if(el.closest('nav,header,footer,aside,form'))return;
    var t=txt(el);
    if(t.length>1)parts.push(t);
  });
  var text=parts.join('\\n\\n');
  if(text.length<200)text=txt(root);
  return { title: document.title||'', url: location.href, text: text };
})()`

export async function fetchArticle(url) {
  if (!/^https?:/i.test(url || '')) throw new Error('bad url')
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: 'persist:mailbrowser', // same logged-in session as the visible internal browser
      images: false, // text only → faster
      backgroundThrottling: false
    }
  })
  try {
    win.loadURL(url)
    // wait for the load to stop (fires even on redirects / partial loads), hard-capped
    await new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      win.webContents.once('did-finish-load', finish)
      win.webContents.once('did-stop-loading', finish)
      setTimeout(finish, 15000)
    })
    await win.webContents.executeJavaScript(WAIT_READY, true)
    const data = await win.webContents.executeJavaScript(EXTRACT, true)
    return {
      title: (data?.title || '').slice(0, 300),
      url: data?.url || url,
      text: (data?.text || '').slice(0, 16000)
    }
  } finally {
    try {
      win.destroy()
    } catch {
      /* already gone */
    }
  }
}
