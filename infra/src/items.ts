// export 名は handler に統一（ズレるとエラー）
export async function handler() {
  return { statusCode: 200, body: JSON.stringify([{ id: 1, name: "test" }]) };
}
