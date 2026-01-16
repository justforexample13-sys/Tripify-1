import axios from 'axios';

let amadeusToken = null;
let amadeusTokenExpiresAt = 0;

function makeAmadeusError(endpoint, status, data, fallbackMessage) {
  const first = data?.errors?.[0];
  const msg = first?.detail || first?.title || fallbackMessage || 'Amadeus API error';
  const err = new Error(msg);
  err.status = status;
  err.endpoint = endpoint;
  err.amadeus = data;
  return err;
}

async function getAmadeusToken() {
  const now = Date.now();
  if (amadeusToken && now < amadeusTokenExpiresAt - 30000) {
    return amadeusToken;
  }

  const apiKey = process.env.AMADEUS_API_KEY;
  const apiSecret = process.env.AMADEUS_API_SECRET;
  const baseUrl = process.env.AMADEUS_BASE_URL || 'https://test.api.amadeus.com';

  if (!apiKey || !apiSecret) {
    throw new Error('AMADEUS_API_KEY / AMADEUS_API_SECRET not configured');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: apiKey,
    client_secret: apiSecret,
  });

  const response = await axios.post(`${baseUrl}/v1/security/oauth2/token`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  amadeusToken = response.data?.access_token;
  amadeusTokenExpiresAt = Date.now() + (response.data?.expires_in || 1799) * 1000;
  return amadeusToken;
}

async function amadeusFetch(endpoint, params = {}) {
  const token = await getAmadeusToken();
  const baseUrl = process.env.AMADEUS_BASE_URL || 'https://test.api.amadeus.com';

  const url = new URL(`${baseUrl}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await axios.get(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.data;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { from, to, date, returnDate, adults, class: travelClass } = req.query;
    const originLocationCode = (req.query.originLocationCode || from || '').toString().toUpperCase();
    const destinationLocationCode = (req.query.destinationLocationCode || to || '').toString().toUpperCase();
    const departureDate = (req.query.departureDate || date || '').toString();
    const returnDateValue = (req.query.returnDate || returnDate || '').toString();

    if (!originLocationCode || !destinationLocationCode || !departureDate) {
      return res.status(400).json({ error: 'Missing required params: from, to, date' });
    }

    const params = {
      originLocationCode,
      destinationLocationCode,
      departureDate,
      adults: adults || '1',
      currencyCode: 'USD',
      max: '20'
    };

    if (returnDateValue) {
      params.returnDate = returnDateValue;
    }

    if (travelClass) {
      params.travelClass = travelClass.toUpperCase();
    }

    const data = await amadeusFetch('/v2/shopping/flight-offers', params);
    res.json(data);
  } catch (err) {
    console.error('Flight offers error:', err?.message);
    res.status(err?.status || 500).json({
      error: err?.message || 'Failed to fetch flight offers',
      endpoint: err?.endpoint,
      amadeus: err?.amadeus,
    });
  }
}
