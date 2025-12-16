import {
  ApiResponse,
  NameCheckData,
  ExpiryData,
  HistoryData,
  PortfolioData,
  Address,
} from "./types";
const COCO_CORE_URL = process.env.COCO_CORE_URL;

export async function checkNames(
  names: string[],
): Promise<ApiResponse<NameCheckData>> {
  const params = new URLSearchParams();

  names.forEach((name) => params.append("name", name));

  const url_action = `api/check/names?${params.toString()}`;
  const nameResponse = await fetchHandler<NameCheckData>(url_action);

  return nameResponse;
}

export async function getExpiry(
  names: string[],
): Promise<ApiResponse<ExpiryData>> {
  const params = new URLSearchParams();

  names.forEach((name) => params.append("name", name));

  const url_action = `api/expiry/names?${params.toString()}`;

  const expiryResponse = await fetchHandler<ExpiryData>(url_action);

  return expiryResponse;
}

export async function getHistory(
  name: string,
): Promise<ApiResponse<HistoryData>> {
  const url_action = `api/history/names?name=${name}`;

  const historyResponse = await fetchHandler<HistoryData>(url_action);

  return historyResponse;
}
export async function getENSPortfolio(
  address: Address,
): Promise<ApiResponse<PortfolioData>> {
  const url_action = `api/portfolio/address?address=${address.toString()}`;

  const addressResponse = await fetchHandler<PortfolioData>(url_action);

  return addressResponse;
}

async function fetchHandler<T>(actionURL: string): Promise<ApiResponse<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10 seconds

  try {
    const response = await fetch(`${COCO_CORE_URL}/${actionURL}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        success: false,
        error: "Something went wrong during the API call",
      };
    }

    let data = await response.json();

    return data;
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === "AbortError") {
        return {
          success: false,
          error: `I think the request too way too long but here's more info: ${error.message}`,
        };
      }

      return {
        success: false,
        error: error.message, // TODO: fix
      };
    }

    return {
      success: false,
      error: "Can't place my hand on it but there has been an error",
    };
  } finally {
    clearTimeout(timeout);
  }
}
