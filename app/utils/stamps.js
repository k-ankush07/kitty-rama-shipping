import axios from "axios";

const STAMPS_REST_BASE = "https://api.stamps.com/rest/v1";

const CLIENT_ID = process.env.STAMPS_CLIENT_ID;
const CLIENT_SECRET = process.env.STAMPS_CLIENT_SECRET;

async function getAccessToken() {
  try {
    const res = await axios.post(
      `${STAMPS_REST_BASE}/oauth/token`,
      {
        grant_type: "client_credentials",
        scope: "offline_access",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      },
    );

    return res.data.access_token;
  } catch (err) {
    console.error("Stamps OAuth Token Error:", err.response?.data || err);
    throw err;
  }
}

export async function createStampsLabel(order) {
  const token = await getAccessToken();

  const DEFAULT_FROM = {
    name: "Kitty Rama Shipping",
    address1: "10 Main Street",
    city: "Los Angeles",
    state: "CA",
    zip: "90001",
    country: "US",
    phone: "3105551234",
  };

  const TO = {
    name: order?.shipping_address?.name || "Customer",
    address1: order?.shipping_address?.address1 || "123 Default St",
    address2: order?.shipping_address?.address2 || "",
    city: order?.shipping_address?.city,
    state: order?.shipping_address?.province_code,
    zip: order?.shipping_address?.zip,
    country: order?.shipping_address?.country_code,
    phone: order?.shipping_address?.phone || "0000000000",
  };

  try {
    const res = await axios.post(
      `${STAMPS_REST_BASE}/labels`,
      {
        shipment: {
          from: DEFAULT_FROM,
          to: TO,
          weight_oz: 4,
          service_type: "usps_first_class_mail",
          package_type: "package",
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
    );

    return {
      trackingNumber: res.data.tracking_number,
      labelURL: res.data.label_url,
    };
  } catch (err) {
    console.error("Stamps REST Label Error:", err.response?.data || err);
    throw err;
  }
}
