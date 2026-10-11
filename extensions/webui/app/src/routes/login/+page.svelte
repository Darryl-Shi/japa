<script lang="ts">
  import { page } from "$app/state";

  const failed = $derived(page.url.searchParams.has("error"));
</script>

<svelte:head>
  <title>Sign in · japa</title>
</svelte:head>

<main class="login">
  <form class="card" method="POST" action="/login">
    <h1 class="wordmark">japa</h1>
    <label class="label" for="token">Access token</label>
    <input
      class="field"
      id="token"
      name="token"
      type="password"
      autocomplete="current-password"
      required
      aria-describedby={failed ? "token-hint token-error" : "token-hint"}
      aria-invalid={failed ? "true" : undefined}
    />
    {#if failed}
      <p class="error" id="token-error" role="alert">That token didn't work.</p>
    {/if}
    <button class="btn primary submit" type="submit">Sign in</button>
    <p class="hint" id="token-hint">The token is in <code>~/.japa/secrets/webui.token</code> on the machine running japa.</p>
  </form>
</main>

<style>
  .login {
    flex: 1;
    display: grid;
    place-items: center;
    padding: 1.5rem 1rem;
    background: var(--bg-soft);
  }

  .card {
    width: 100%;
    max-width: 360px;
    padding: 2rem 1.75rem 1.5rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
  }

  .wordmark {
    margin: 0 0 1.5rem;
    font-size: var(--text-xl);
    font-weight: 650;
    letter-spacing: -0.03em;
    text-align: center;
  }

  .label {
    margin-bottom: 0.4rem;
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .error {
    margin: 0.6rem 0 0;
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .submit {
    margin-top: 1rem;
    min-height: 2.5rem;
  }

  .hint {
    margin: 1.1rem 0 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    text-align: center;
    line-height: 1.5;
  }

  .hint code {
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
</style>
