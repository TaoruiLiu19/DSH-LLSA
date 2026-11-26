export const LOCAL_PANEL_STYLE = `
:root{color-scheme:light;font:16px/1.55 system-ui,sans-serif;color:#172c31;background:#f1f6f5}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0}
a{color:#12605b;text-underline-offset:3px}
a:focus-visible,button:focus-visible,input:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #16847a;outline-offset:3px}
.top{background:#173b3a;color:#fff}
.top-inner,.layout{width:min(1180px,100% - 40px);margin:auto}
.top-inner{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:16px 0}
.brand{font-weight:700}
.top nav{display:flex;gap:18px;flex-wrap:wrap}
.top a{color:#d9f3ed}
.layout{padding:32px 0 48px}
h1,h2,h3,p{margin:0}
h1{font-size:clamp(1.85rem,5vw,2.6rem);line-height:1.15;letter-spacing:-.035em}
.lead{margin:10px 0 24px;color:#405d60}
.columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start;gap:20px}
.card{padding:22px;border:1px solid #cededb;border-radius:14px;background:#fff}
.card-heading,.actions{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
h2{font-size:1.18rem}
h3{font-size:1rem;overflow-wrap:anywhere}
.action-group{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
fieldset{padding:0;border:0;margin:16px 0}
legend,.field-label{display:block;font-weight:650;margin-bottom:6px}
.modes{display:flex;gap:6px}
.modes button[aria-pressed=true]{background:#d9ede9;border-color:#519389;color:#104842}
button{min-height:37px;padding:6px 12px;border:1px solid #adbfbc;border-radius:8px;background:#fff;color:#173b3a;font:inherit;cursor:pointer}
button:hover:not(:disabled){background:#edf5f3}
button.primary{background:#106b61;border-color:#106b61;color:#fff;font-weight:650}
button.primary:hover:not(:disabled){background:#0d564f}
button:disabled{opacity:.55;cursor:wait}
button.subtle{border-color:transparent;padding-inline:6px;text-decoration:underline;text-underline-offset:3px}
small,.muted,.empty{font-size:.87rem;color:#466366}
.actions{margin-top:15px;justify-content:flex-start}
.actions:empty{display:none}
.file-fields{margin-top:15px;padding:14px;background:#f4f8f7;border:1px solid #dce9e6;border-radius:10px}
.options{margin-top:14px}
.check{display:flex;align-items:baseline;gap:8px;font-size:.9rem}
.check input{margin-left:0}
textarea,input[type=text],input[type=file]{width:100%;font:inherit}
textarea,input[type=text]{padding:9px 11px;border:1px solid #aabfbb;border-radius:7px;background:#fff;color:#172c31}
textarea{min-height:148px;resize:vertical}
input[type=file]{font-size:.86rem;color:#28484a}
input[type=file]::file-selector-button{margin-right:8px;padding:6px 9px;border:1px solid #aabfbb;border-radius:6px;background:#fff;font:inherit;color:#173b3a;cursor:pointer}
.file-fields small,.options small{display:block;margin:5px 0 10px}
.uploads,.files,.reply-list{list-style:none;margin:0;padding:0}
.uploads>li{padding:9px 0;border-bottom:1px solid #dce9e6}
.uploads>li:last-child{border-bottom:0}
.file-row{display:flex;justify-content:space-between;align-items:center;gap:8px;overflow-wrap:anywhere}
.file-row input[type=text]{flex:1;min-width:0}
.file-row button,.files button{font-size:.84rem}
.ticket{padding:15px 0;border-bottom:1px solid #dce9e6}
.ticket:last-child{border-bottom:0;padding-bottom:0}
.ticket-info{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.status{font-size:.82rem;white-space:nowrap;color:#425e61}
.status[data-state=delivered]{color:#12604c}
.status[data-state=blocked]{color:#85400b}
.ticket p{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:7px}
.ticket .actions{margin-top:10px}
.ticket details{margin-top:9px}
.ticket summary{cursor:pointer;color:#12605b;font-size:.87rem}
.ticket code{font-size:.83rem;overflow-wrap:anywhere;user-select:all}
.files{margin-top:9px}
.files>li{padding:4px 0;font-size:.88rem}
.files .file-label{display:block;color:#466366;font-size:.78rem}
.empty{padding:14px 0 2px}
#notice,#error,#task-error{margin-top:8px;font-size:.9rem;overflow-wrap:anywhere}
#error,#task-error{color:#a12621}
#notice{color:#14604f}
#notice:empty,#error:empty,#task-error:empty{margin:0}
.reply-list li{padding:7px 0;white-space:pre-wrap;overflow-wrap:anywhere}
#replies:not([hidden]){border-top:1px solid #dce9e6;margin-top:16px;padding-top:9px}
#replies summary{cursor:pointer;color:#12605b}
@media(max-width:760px){.columns{grid-template-columns:1fr}.layout{padding-top:23px}.card{padding:17px}.top-inner,.layout{width:calc(100% - 28px)}.top nav{gap:10px;font-size:.83rem}}
`
