import React, { useState } from 'react';

interface EndpointButton {
  label: string;
  method: 'GET' | 'POST';
  url: string;
  body?: any;
  headers?: Record<string, string>;
  category: 'Orders' | 'GraphQL' | 'Edge Cases' | 'Errors & Others';
}

const ENDPOINTS: EndpointButton[] = [
  // Orders
  { label: 'Load Orders Page 1', method: 'GET', url: '/api/orders?page=1', category: 'Orders' },
  { label: 'Load Orders Page 2', method: 'GET', url: '/api/orders?page=2', category: 'Orders' },
  { label: 'Load Orders Page 3', method: 'GET', url: '/api/orders?page=3', category: 'Orders' },
  { label: 'Load Order Detail #9182', method: 'GET', url: '/api/orders/9182', category: 'Orders' },
  { label: 'Load Order #9182 Items', method: 'GET', url: '/api/orders/9182/items', category: 'Orders' },
  { label: 'Load Customer #44', method: 'GET', url: '/api/customers/44', category: 'Orders' },

  // GraphQL
  {
    label: 'Run GraphQL OrdersQuery',
    method: 'POST',
    url: '/graphql',
    body: JSON.stringify({
      operationName: 'OrdersQuery',
      query: 'query OrdersQuery { orders { id status total } }',
    }),
    category: 'GraphQL',
  },
  {
    label: 'Run GraphQL CustomerQuery',
    method: 'POST',
    url: '/graphql',
    body: JSON.stringify({
      operationName: 'CustomerQuery',
      query: 'query CustomerQuery { customer { id name tier } }',
    }),
    category: 'GraphQL',
  },

  // Edge Cases
  { label: 'Load Root Array', method: 'GET', url: '/api/root-array', category: 'Edge Cases' },
  { label: 'Load Nested JSON', method: 'GET', url: '/api/nested', category: 'Edge Cases' },
  { label: 'Load Mixed Types (Anomalies)', method: 'GET', url: '/api/mixed-types', category: 'Edge Cases' },
  { label: 'Load Duplicates', method: 'GET', url: '/api/duplicates', category: 'Edge Cases' },

  // Errors & Others
  { label: 'Trigger 500 Error', method: 'GET', url: '/api/error', category: 'Errors & Others' },
  { label: 'Load HTML Document', method: 'GET', url: '/api/html', category: 'Errors & Others' },
  {
    label: 'Search POST Request (with Auth Header)',
    method: 'POST',
    url: '/api/search',
    headers: { Authorization: 'Bearer secret-fixture-token-12345', 'X-API-Key': 'my-secret-key' },
    body: JSON.stringify({ query: 'search keywords', token: 'param-token' }),
    category: 'Errors & Others',
  },
];

export default function App() {
  const [logs, setLogs] = useState<Array<{ id: number; method: string; url: string; status: number; body: string }>>([]);
  const [loading, setLoading] = useState(false);

  const triggerRequest = async (ep: EndpointButton) => {
    setLoading(true);
    try {
      const res = await fetch(ep.url, {
        method: ep.method,
        headers: ep.headers || { 'Content-Type': 'application/json' },
        body: ep.body,
      });

      const text = await res.text();
      let formatted = text;
      try {
        formatted = JSON.stringify(JSON.parse(text), null, 2);
      } catch {}

      setLogs(prev => [
        {
          id: Date.now() + Math.random(),
          method: ep.method,
          url: ep.url,
          status: res.status,
          body: formatted,
        },
        ...prev.slice(0, 49),
      ]);
    } catch (err: any) {
      setLogs(prev => [
        {
          id: Date.now() + Math.random(),
          method: ep.method,
          url: ep.url,
          status: 0,
          body: err.message,
        },
        ...prev,
      ]);
    } finally {
      setLoading(false);
    }
  };

  const triggerFullAcceptanceScenario = async () => {
    setLoading(true);
    const scenario = [
      ENDPOINTS[0], // page 1
      ENDPOINTS[1], // page 2
      ENDPOINTS[2], // page 3
      ENDPOINTS[5], // customer 44
      ENDPOINTS[4], // order 9182 items
    ];

    for (const ep of scenario) {
      await triggerRequest(ep);
      await new Promise(r => setTimeout(r, 200));
    }
    setLoading(false);
  };

  const categories = ['Orders', 'GraphQL', 'Edge Cases', 'Errors & Others'] as const;

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 24px' }}>
      <header style={{ marginBottom: 32, borderBottom: '1px solid #1e293b', paddingBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ margin: '0 0 8px 0', fontSize: 28, fontWeight: 700, color: '#38bdf8' }}>
              Network Data Workbench Fixture App
            </h1>
            <p style={{ margin: 0, color: '#94a3b8', fontSize: 14 }}>
              Deterministic test harness for Chrome DevTools capture, schema inference, and SQL datasets.
            </p>
          </div>
          <button
            onClick={triggerFullAcceptanceScenario}
            disabled={loading}
            style={{
              background: 'linear-gradient(135deg, #0284c7, #2563eb)',
              color: '#ffffff',
              border: 'none',
              borderRadius: 8,
              padding: '12px 20px',
              fontSize: 14,
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              boxShadow: '0 4px 14px rgba(37, 99, 235, 0.4)',
            }}
          >
            🚀 Run V1 Acceptance Scenario
          </button>
        </div>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <div>
          <h2 style={{ fontSize: 18, color: '#f8fafc', marginBottom: 16 }}>Test Triggers</h2>
          {categories.map(cat => (
            <div key={cat} style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', color: '#64748b', marginBottom: 8, letterSpacing: '0.05em' }}>
                {cat}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {ENDPOINTS.filter(e => e.category === cat).map((ep, i) => (
                  <button
                    key={i}
                    onClick={() => triggerRequest(ep)}
                    disabled={loading}
                    style={{
                      background: '#1e293b',
                      color: '#e2e8f0',
                      border: '1px solid #334155',
                      borderRadius: 6,
                      padding: '8px 14px',
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <span style={{ color: ep.method === 'GET' ? '#38bdf8' : '#a855f7', fontWeight: 700, marginRight: 6 }}>
                      {ep.method}
                    </span>
                    {ep.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ fontSize: 18, color: '#f8fafc', margin: 0 }}>Trigger Log ({logs.length})</h2>
            {logs.length > 0 && (
              <button
                onClick={() => setLogs([])}
                style={{
                  background: 'transparent',
                  color: '#94a3b8',
                  border: '1px solid #334155',
                  borderRadius: 4,
                  padding: '4px 10px',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Clear Log
              </button>
            )}
          </div>

          <div
            style={{
              background: '#0f172a',
              border: '1px solid #1e293b',
              borderRadius: 8,
              height: 520,
              overflowY: 'auto',
              padding: 12,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12,
            }}
          >
            {logs.length === 0 ? (
              <div style={{ color: '#475569', textAlign: 'center', marginTop: 180 }}>
                No requests triggered yet. Click any button on the left to fire network calls.
              </div>
            ) : (
              logs.map(log => (
                <div
                  key={log.id}
                  style={{
                    marginBottom: 12,
                    borderBottom: '1px solid #1e293b',
                    paddingBottom: 10,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                    <span>
                      <strong style={{ color: log.method === 'GET' ? '#38bdf8' : '#a855f7' }}>{log.method}</strong>{' '}
                      <span style={{ color: '#cbd5e1' }}>{log.url}</span>
                    </span>
                    <span
                      style={{
                        color: log.status === 200 ? '#4ade80' : '#f87171',
                        fontWeight: 600,
                      }}
                    >
                      {log.status || 'ERR'}
                    </span>
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      maxHeight: 120,
                      overflowY: 'auto',
                      color: '#94a3b8',
                      background: '#090d16',
                      padding: 8,
                      borderRadius: 4,
                    }}
                  >
                    {log.body}
                  </pre>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
