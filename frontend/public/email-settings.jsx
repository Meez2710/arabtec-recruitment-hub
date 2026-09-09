/* Email configuration uses the shared ATS API/components. No secrets are read
   back; a password enters a request only after the admin chooses Replace. */
(function () {
  const {useState, useEffect, useCallback} = React;
  const fields = ['provider','host','port','encryption','user','from','fromName','replyTo'];
  const editable = (s) => Object.fromEntries(fields.map(k => [k,s[k]]));
  window.ArabtecEmailSettingsPage = function EmailSettingsPage({PageHead, Empty, Skeleton, Icon}) {
    const api = window.ARABTEC_API;
    const [data,setData] = useState(null);
    const [form,setForm] = useState(null);
    const [replace,setReplace] = useState(false);
    const [password,setPassword] = useState('');
    const [to,setTo] = useState('');
    const [busy,setBusy] = useState('');
    const [error,setError] = useState('');
    const [notice,setNotice] = useState('');
    const [testResult,setTestResult] = useState(null);
    const load = useCallback(async () => {
      setError('');
      try { const r=await api.get('/settings/email'); setData(r);setForm(editable(r.settings));setPassword('');setReplace(false); }
      catch(e) {setError(e.message);}
    }, []);
    useEffect(()=>{load();},[load]);
    const dirty = !!data && (JSON.stringify(form)!==JSON.stringify(editable(data.settings)) || replace);
    useEffect(()=>{
      if (!dirty) return;
      const before = e=>{e.preventDefault(); e.returnValue='';};
      const navigate=e=>{if(!window.confirm('Discard unsaved email settings?'))e.preventDefault();};
      window.addEventListener('beforeunload',before);
      window.addEventListener('ats:before-navigate',navigate);
      return ()=>{window.removeEventListener('beforeunload',before);window.removeEventListener('ats:before-navigate',navigate);};
    },[dirty]);
    const change = (key,value)=>{setForm(f=>({...f,[key]:value}));setTestResult(null);setNotice('');setError('');};
    const payload = ()=>({...form,...(replace?{password}:{})});
    async function save(e) {
      e.preventDefault();setBusy('save');setError('');setNotice('');
      try {const r=await api.put('/settings/email',payload());setData(r);setForm(editable(r.settings));setPassword('');setReplace(false);setTestResult(null);setNotice('Email settings saved.');}
      catch(e){setError(e.message);}finally{setBusy('');}
    }
    async function test(send) {
      setBusy(send?'send':'verify');setError('');setNotice('');
      try {const r=await api.post('/settings/email/test',{settings:payload(),...(send?{to}:{})});setTestResult(r);
        setNotice(r.provider==='dry-run'?'Test completed in dry-run mode. No email was sent.':send?'Test email accepted by the provider. Check the recipient inbox.':'Connection verified. These draft settings have not been saved.');}
      catch(e){setError(e.message);setTestResult(null);}finally{setBusy('');}
    }
    async function verifySaved() {
      setBusy('saved');setError('');setNotice('');
      try {const r=await api.post('/settings/email/verify',{}); const refreshed=await api.get('/settings/email');setData(refreshed);
        setNotice(r.provider==='dry-run'?'Dry-run is enabled. A live connection has not been verified.':'Saved connection verified.');}
      catch(e){setError(e.message);}finally{setBusy('');}
    }
    if (!form) return <div><PageHead crumb="Administration / Email" title="Email & Mailbox" sub="Connect the mailbox used for recruitment messages." />{error?<Empty tone="error" title="Email settings unavailable" text={error} action={<button className="btn btn-secondary" onClick={load}>Retry</button>}/>:<Skeleton rows={6}/>}</div>;
    const graph = form.provider==='graph';
    const connected = data.microsoft?.connected;
    const providerLabel = {'graph':'Microsoft 365','smtp':'SMTP','dry-run':'Dry-run','none':'Not configured'}[data.provider] || data.provider;
    const field = (key,label,props={}) => <div className="field"><label htmlFor={'email-'+key}>{label}</label><input id={'email-'+key} value={form[key]??''} onChange={e=>change(key,e.target.value)} {...props}/></div>;
    return <div>
      <PageHead crumb="Administration / Email" title="Email & Mailbox" sub="Manage the sender and connection used for recruitment messages." />
      {error&&<div className="notice notice-danger" role="alert"><strong>Connection or save failed</strong><p>{error}</p><span className="muted">Check the connection details or reconnect Microsoft 365, then retry.</span></div>}
      {notice&&<div className="notice" role="status">{notice}</div>}
      <div className="email-settings-grid">
        <form onSubmit={save} className="email-settings-form">
          <fieldset disabled={!!busy} className="email-fieldset">
            <section className="card">
              <div className="card-head"><h3>Sender details</h3></div>
              <div className="card-pad form-grid">
                <div className="field"><label htmlFor="email-provider">Provider</label><select id="email-provider" value={form.provider} onChange={e=>change('provider',e.target.value)}><option value="auto">Automatic (Microsoft 365 first)</option><option value="graph">Microsoft 365 (OAuth)</option><option value="smtp">SMTP server</option></select></div>
                {field('fromName','From name',{maxLength:254,disabled:graph})}
                {field('from','From address',{type:'email',maxLength:254,disabled:graph})}
                {field('replyTo','Reply-to (optional)',{type:'email',maxLength:254})}
              </div>
              {(graph||form.provider==='auto')&&<div className="card-pad email-provider-note"><Icon name="mail"/> <span>Microsoft 365 sends as <strong>{data.microsoft?.mailbox||'the connected career mailbox'}</strong>. Its name and From address are managed in Outlook. SMTP sender details apply when SMTP is used.</span></div>}
            </section>
            {graph ? <section className="card card-pad"><h3>Microsoft 365 connection</h3><p>{connected?'Your mailbox connection is available.':'Connect the company mailbox to receive CVs and send recruitment emails.'}</p><a href="#microsoft" className="btn btn-secondary">{connected?'Manage Microsoft 365':'Connect Microsoft 365'}</a><p className="muted">Incoming CVs go to Candidate Review for approval.</p></section> : <section className="card">
              <div className="card-head"><h3>SMTP connection</h3></div>
              <div className="card-pad form-grid">
                {field('host','Host',{autoComplete:'off'})}
                <div className="field"><label htmlFor="email-port">Port</label><input id="email-port" type="number" min="1" max="65535" value={form.port} onChange={e=>change('port',e.target.value===''?'':Number(e.target.value))}/></div>
                <div className="field"><label htmlFor="email-encryption">Encryption</label><select id="email-encryption" value={form.encryption} onChange={e=>change('encryption',e.target.value)}><option value="starttls">STARTTLS</option><option value="tls">SSL / TLS</option><option value="none">None</option></select></div>
                {field('user','Username',{autoComplete:'off'})}
                <div className="field email-password-field"><label htmlFor="email-password">Password</label>{replace?<><input id="email-password" type="password" autoComplete="new-password" value={password} onChange={e=>{setPassword(e.target.value);setTestResult(null);}} required/><button type="button" className="btn btn-ghost btn-sm" onClick={()=>{setReplace(false);setPassword('');}}>Cancel replacement</button></>:<div className="email-password-row"><span>{data.settings.passwordSet?'Credential stored securely':'No password configured'}</span><button type="button" className="btn btn-secondary btn-sm" onClick={()=>setReplace(true)} disabled={!data.settings.encryptionReady}>{data.settings.passwordSet?'Replace':'Set password'}</button></div>}
                  {!data.settings.encryptionReady&&<span className="muted">A server encryption key is required to save a password. Ask the system administrator to configure MICROSOFT_TOKEN_ENCRYPTION_KEY.</span>}
                  {data.settings.passwordSetAt&&<span className="muted">Replaced {new Date(data.settings.passwordSetAt).toLocaleString()}</span>}
                </div>
              </div>
            </section>}
            <div className="email-settings-actions"><span className="muted">{dirty?'Unsaved changes':'Settings are up to date'}</span><button className="btn" type="submit" disabled={!dirty||(replace&&!password)}>{busy==='save'?'Saving…':'Save changes'}</button></div>
          </fieldset>
        </form>
        <aside className="email-settings-aside">
          <section className="card"><div className="card-head"><h3>Connection status</h3></div><div className="card-pad">
            <span className="badge">{providerLabel}</span>
            <dl className="email-status-list"><dt>Last verified</dt><dd>{data.lastVerified?.at?new Date(data.lastVerified.at).toLocaleString():'Not yet verified'}</dd><dt>Sent this month</dt><dd>{data.delivery?.sentThisMonth ?? 0}<small className="muted"> · counted since this update</small></dd><dt>Last successful CV sync</dt><dd>{data.microsoft?.lastSuccessfulSyncAt?new Date(data.microsoft.lastSuccessfulSyncAt).toLocaleString():'No completed sync'}</dd></dl>
            <button type="button" className="btn btn-secondary" disabled={!!busy} onClick={verifySaved}>{busy==='saved'?'Checking…':'Verify saved connection'}</button>
          </div></section>
          <section className="card"><div className="card-head"><h3>Test these settings</h3></div><div className="card-pad">
            <p className="muted">Tests use the values in this form. Save changes separately when ready.</p>
            <div className="field"><label htmlFor="email-test-recipient">Test recipient</label><input id="email-test-recipient" type="email" value={to} onChange={e=>setTo(e.target.value)} placeholder="you@company.com"/></div>
            <div className="email-test-actions"><button type="button" className="btn btn-secondary" disabled={!!busy||(replace&&!password)} onClick={()=>test(false)}>{busy==='verify'?'Testing…':'Test connection'}</button><button type="button" className="btn" disabled={!!busy||!to||(replace&&!password)} onClick={()=>test(true)}>{busy==='send'?'Sending…':'Send test email'}</button></div>
            {testResult&&<p className="muted">{testResult.provider==='dry-run'?'Dry-run passed':'Test passed'} · {new Date(testResult.verifiedAt).toLocaleTimeString()}</p>}
          </div></section>
          <a href="#notifications" className="email-settings-link">Manage notification rules</a>
        </aside>
      </div>
    </div>;
  };
})();
