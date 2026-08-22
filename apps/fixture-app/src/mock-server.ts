/**
 * Deterministic Mock API Handlers for Testing Extension Capture & Datasets
 */

export interface MockHttpRequest {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

export interface MockHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function generateOrdersPage(page: number, pageSize: number = 100) {
  const startId = (page - 1) * pageSize + 1;
  const orders = [];
  const statuses = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
  const cities = ['Toronto', 'Vancouver', 'Montreal', 'Calgary', 'Ottawa'];

  for (let i = 0; i < pageSize; i++) {
    const id = startId + i;
    const customerId = (id % 50) + 1;
    const status = statuses[id % statuses.length];
    const total = Math.round((20 + (id * 13.37) % 500) * 100) / 100;
    const city = cities[id % cities.length];

    orders.push({
      id,
      customer_id: customerId,
      status,
      total,
      created_at: `2026-08-${String((id % 28) + 1).padStart(2, '0')}T10:00:00Z`,
      customer: {
        id: customerId,
        name: `Customer ${customerId}`,
        address: {
          city,
          country: 'Canada',
        },
      },
    });
  }

  return {
    total: 8247,
    page,
    pageSize,
    hasMore: page < 83,
    data: {
      orders,
    },
  };
}

export async function handleMockRequest(req: MockHttpRequest): Promise<MockHttpResponse> {
  const urlObj = new URL(req.url, 'http://localhost:5173');
  const pathname = urlObj.pathname;
  const searchParams = urlObj.searchParams;

  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  // GET /api/orders
  if (pathname === '/api/orders' && req.method === 'GET') {
    const page = parseInt(searchParams.get('page') || '1', 10);
    const pageSize = parseInt(searchParams.get('pageSize') || '100', 10);
    return {
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify(generateOrdersPage(page, pageSize)),
    };
  }

  // GET /api/orders/:id/items
  const itemsMatch = /^\/api\/orders\/(\d+)\/items$/.exec(pathname);
  if (itemsMatch && req.method === 'GET') {
    const orderId = parseInt(itemsMatch[1], 10);
    return {
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        order_id: orderId,
        items: [
          { item_id: orderId * 10 + 1, sku: 'SKU-A101', quantity: 2, unit_price: 24.99 },
          { item_id: orderId * 10 + 2, sku: 'SKU-B202', quantity: 1, unit_price: 34.14 },
        ],
      }),
    };
  }

  // GET /api/orders/:id
  const orderMatch = /^\/api\/orders\/(\d+)$/.exec(pathname);
  if (orderMatch && req.method === 'GET') {
    const orderId = parseInt(orderMatch[1], 10);
    return {
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        id: orderId,
        customer_id: 44,
        status: 'shipped',
        total: 84.12745,
        created_at: '2026-08-21T22:14:51Z',
      }),
    };
  }

  // GET /api/customers/:id
  const customerMatch = /^\/api\/customers\/(\d+)$/.exec(pathname);
  if (customerMatch && req.method === 'GET') {
    const customerId = parseInt(customerMatch[1], 10);
    return {
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        id: customerId,
        name: `Customer ${customerId}`,
        email: `user${customerId}@example.com`,
        tier: 'platinum',
        loyalty_points: 1450,
      }),
    };
  }

  // GET /api/root-array
  if (pathname === '/api/root-array' && req.method === 'GET') {
    return {
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify([
        { id: 1, name: 'Root Item 1', active: true },
        { id: 2, name: 'Root Item 2', active: false },
        { id: 3, name: 'Root Item 3', active: true },
      ]),
    };
  }

  // GET /api/nested
  if (pathname === '/api/nested' && req.method === 'GET') {
    return {
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        company: {
          name: 'Acme Corp',
          hq: {
            city: 'San Francisco',
            coordinates: { lat: 37.7749, lon: -122.4194 },
          },
        },
      }),
    };
  }

  // GET /api/mixed-types
  if (pathname === '/api/mixed-types' && req.method === 'GET') {
    return {
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        records: [
          { id: 1, code: 100, amount: 45.5 },
          { id: 2, code: 200, amount: 99.0 },
          { id: 3, code: 'N/A', amount: 'unknown' }, // Anomalous row
          { id: 4, code: 300, amount: 15.0 },
        ],
      }),
    };
  }

  // GET /api/duplicates
  if (pathname === '/api/duplicates' && req.method === 'GET') {
    return {
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        items: [
          { id: 1, status: 'v1_initial', timestamp: '2026-08-20T01:00:00Z' },
          { id: 1, status: 'v1_updated', timestamp: '2026-08-21T01:00:00Z' },
          { id: 2, status: 'v1_single', timestamp: '2026-08-20T01:00:00Z' },
        ],
      }),
    };
  }

  // POST /graphql
  if (pathname === '/graphql' && req.method === 'POST') {
    let parsedBody: any = {};
    try {
      parsedBody = JSON.parse(req.body);
    } catch {}

    const opName = parsedBody.operationName;

    if (opName === 'OrdersQuery' || req.body.includes('OrdersQuery')) {
      return {
        status: 200,
        headers: jsonHeaders,
        body: JSON.stringify({
          data: {
            orders: [
              { id: 9182, status: 'shipped', total: 84.12745 },
              { id: 9183, status: 'pending', total: 42.11 },
            ],
          },
        }),
      };
    }

    return {
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        data: {
          customer: {
            id: 44,
            name: 'Customer 44',
            tier: 'gold',
          },
        },
      }),
    };
  }

  // POST /api/search
  if (pathname === '/api/search' && req.method === 'POST') {
    return {
      status: 200,
      headers: jsonHeaders,
      body: JSON.stringify({
        query: req.body,
        results: [
          { id: 101, title: 'Matching Item 1', score: 0.95 },
          { id: 102, title: 'Matching Item 2', score: 0.88 },
        ],
      }),
    };
  }

  // GET /api/error
  if (pathname === '/api/error') {
    return {
      status: 500,
      headers: jsonHeaders,
      body: JSON.stringify({
        error: 'InternalServerError',
        message: 'Something went wrong processing request',
        code: 500,
      }),
    };
  }

  // GET /api/html
  if (pathname === '/api/html') {
    return {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
      body: '<!DOCTYPE html><html><body><h1>HTML Document</h1></body></html>',
    };
  }

  return {
    status: 404,
    headers: jsonHeaders,
    body: JSON.stringify({ error: 'NotFound', path: pathname }),
  };
}
