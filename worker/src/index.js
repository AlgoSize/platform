export default {
  async fetch(request) {
    const url = new URL(request.url);
    return new Response(
      JSON.stringify({
        ok: true,
        message: "algosize-worker hello world",
        path: url.pathname,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  },
};
