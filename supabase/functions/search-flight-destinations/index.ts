import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Cache token in memory
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAmadeusToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  const apiKey = Deno.env.get('AMADEUS_API_KEY');
  const apiSecret = Deno.env.get('AMADEUS_API_SECRET');

  if (!apiKey || !apiSecret) {
    throw new Error('Amadeus API credentials not configured');
  }

  const response = await fetch('https://test.api.amadeus.com/v1/security/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=client_credentials&client_id=${apiKey}&client_secret=${apiSecret}`,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Amadeus auth error:', response.status, errorText);
    throw new Error('Failed to authenticate with Amadeus');
  }

  const data = await response.json();

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };

  return data.access_token;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { origin, maxPrice, currency } = await req.json();

    const originCode = String(origin || '').toUpperCase().trim();
    if (!originCode) {
      return new Response(JSON.stringify({ destinations: [], error: 'origin is required (IATA code like PAR)' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = await getAmadeusToken();

    const url = new URL('https://test.api.amadeus.com/v1/shopping/flight-destinations');
    url.searchParams.set('origin', originCode);

    if (maxPrice !== undefined && maxPrice !== null && String(maxPrice).trim() !== '') {
      url.searchParams.set('maxPrice', String(maxPrice));
    }
    if (currency) {
      url.searchParams.set('currency', String(currency));
    }

    console.log('Fetching Amadeus flight destinations:', url.toString());

    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    const rawText = await response.text();
    if (!response.ok) {
      console.error('Amadeus flight destinations error:', response.status, rawText);
      return new Response(JSON.stringify({ error: 'Amadeus error', details: rawText, destinations: [] }), {
        status: response.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let json: any;
    try {
      json = JSON.parse(rawText);
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid Amadeus response', details: rawText, destinations: [] }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const destinations = (json.data || []).map((item: any, index: number) => ({
      id: index + 1,
      origin: item.origin,
      destination: item.destination,
      departureDate: item.departureDate,
      returnDate: item.returnDate,
      price: item.price?.total,
      currency: item.price?.currency,
      type: item.type,
    }));

    return new Response(JSON.stringify({ destinations, raw: json }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: unknown) {
    console.error('Error in search-flight-destinations:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message, destinations: [] }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
