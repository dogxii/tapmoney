import api from '../../api.mjs';

export function onRequest({ request, env }) {
  return api.fetch(request, env);
}
