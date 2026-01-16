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
  if (!apiKey || !apiSecret) {
    throw new Error('AMADEUS_API_KEY / AMADEUS_API_SECRET not configured');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: apiKey,
    client_secret: apiSecret,
  });

  const baseUrl = process.env.AMADEUS_BASE_URL || 'https://test.api.amadeus.com';

  const response = await axios.post(`${baseUrl}/v1/security/oauth2/token`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  amadeusToken = response.data?.access_token;
  amadeusTokenExpiresAt = Date.now() + (response.data?.expires_in || 0) * 1000;
  return amadeusToken;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const city = String(req.query.city || req.query.cityCode || '').trim();
    const checkInDate = String(req.query.checkIn || req.query.checkInDate || '').trim();
    const checkOutDate = String(req.query.checkOut || req.query.checkOutDate || '').trim();
    const adults = Number(req.query.adults || 1);

    if (!city) {
      return res.status(400).json({ error: 'city (IATA code or city keyword) is required' });
    }

    const token = await getAmadeusToken();
    const baseUrl = process.env.AMADEUS_BASE_URL || 'https://test.api.amadeus.com';

    let cityCode = city.toUpperCase();
    if (!/^[A-Z]{3}$/.test(cityCode)) {
      const keyword = city.split(',')[0].trim();
      const lookupUrl = new URL(`${baseUrl}/v1/reference-data/locations`);
      lookupUrl.searchParams.set('keyword', keyword);
      lookupUrl.searchParams.set('subType', 'CITY');
      lookupUrl.searchParams.set('page[limit]', '5');

      try {
        const lookupRes = await axios.get(lookupUrl.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
        const found = lookupRes.data?.data?.[0]?.iataCode;
        if (!found) {
          return res.status(404).json({ error: 'No city found for keyword' });
        }
        cityCode = found;
      } catch (err) {
        return res.status(err?.response?.status || 500).json({
          error: 'City lookup failed',
          details: err?.response?.data || err?.message,
        });
      }
    }

    if (checkInDate && checkOutDate) {
      const hotelsUrl = new URL(`${baseUrl}/v1/reference-data/locations/hotels/by-city`);
      hotelsUrl.searchParams.set('cityCode', cityCode);

      let hotelsJson;
      try {
        const hotelsRes = await axios.get(hotelsUrl.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
        hotelsJson = hotelsRes.data;
      } catch (err) {
        const data = err?.response?.data;
        if (data?.errors?.[0]?.code === 895) {
          return res.status(200).json({
            data: [],
            meta: { cityCode, checkInDate, checkOutDate },
            message: 'No hotels found for the selected city',
          });
        }
        throw err;
      }

      const hotelIds = (Array.isArray(hotelsJson?.data) ? hotelsJson.data : [])
        .map((h) => h?.hotelId)
        .filter(Boolean)
        .slice(0, 20);

      if (hotelIds.length === 0) {
        return res.status(200).json({
          data: [],
          meta: { cityCode, checkInDate, checkOutDate },
          message: 'No hotels found for the selected city',
        });
      }

      const offersUrl = new URL(`${baseUrl}/v3/shopping/hotel-offers`);
      offersUrl.searchParams.set('hotelIds', hotelIds.join(','));
      offersUrl.searchParams.set('adults', String(Number.isFinite(adults) ? adults : 1));
      offersUrl.searchParams.set('checkInDate', checkInDate);
      offersUrl.searchParams.set('checkOutDate', checkOutDate);

      let offersJson;
      try {
        const offersRes = await axios.get(offersUrl.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
        offersJson = offersRes.data;
      } catch (err) {
        const data = err?.response?.data;
        if (data?.errors?.[0]?.code === 895) {
          return res.status(200).json({
            data: [],
            meta: { cityCode, checkInDate, checkOutDate },
            message: 'No hotels found for the selected city/dates',
          });
        }
        throw err;
      }

      const data = Array.isArray(offersJson?.data) ? offersJson.data : [];
      return res.json({
        data,
        meta: { cityCode, checkInDate, checkOutDate },
      });
    }

    // Fallback: list hotels in the city
    const hotelsUrl = new URL(`${baseUrl}/v1/reference-data/locations/hotels/by-city`);
    hotelsUrl.searchParams.set('cityCode', cityCode);

    let hotelsJson;
    try {
      const hotelsRes = await axios.get(hotelsUrl.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      hotelsJson = hotelsRes.data;
    } catch (err) {
      const data = err?.response?.data;
      if (data?.errors?.[0]?.code === 895) {
        return res.status(200).json({
          hotels: [],
          meta: { cityCode },
          message: 'No hotels found for the selected city',
        });
      }
      throw err;
    }

    return res.json({ hotels: hotelsJson?.data || [], meta: { cityCode } });
  } catch (err) {
    console.error('Hotels proxy error:', err);
    return res.status(err?.status || 500).json({
      error: err?.message || 'Failed to fetch hotels',
    });
  }
}
