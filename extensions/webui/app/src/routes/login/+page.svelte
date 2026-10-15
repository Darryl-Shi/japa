<script lang="ts">
  import { page } from "$app/state";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
  const failed = $derived(page.url.searchParams.has("error"));
</script>

<svelte:head>
  <title>Sign in · japa</title>
</svelte:head>

<main class="login">
  {#if data.users === "none"}
    <section class="card">
      <h1 class="wordmark">japa</h1>
      <p class="empty">No web UI users yet.</p>
      <p class="hint">On the machine running japa, run <code>japa webui users add &lt;name&gt;</code>, then reload this page.</p>
    </section>
  {:else}
    <form class="card" method="POST" action="/login">
      <h1 class="wordmark">japa</h1>
      <label class="label" for="username">Username</label>
      <input
        class="field"
        id="username"
        name="username"
        type="text"
        autocomplete="username"
        autocapitalize="none"
        spellcheck="false"
        required
        aria-invalid={failed ? "true" : undefined}
      />
      <label class="label second" for="password">Password</label>
      <input
        class="field"
        id="password"
        name="password"
        type="password"
        autocomplete="current-password"
        required
        aria-describedby={failed ? "login-error" : undefined}
        aria-invalid={failed ? "true" : undefined}
      />
      {#if failed}
        <p class="error" id="login-error" role="alert">Wrong username or password.</p>
      {/if}
      <button class="btn primary submit" type="submit">Sign in</button>
      {#if data.users === "unreadable"}
        <p class="hint">japa can't read its web UI users file, so nobody can sign in: see <code>japa status</code>.</p>
      {/if}
    </form>
  {/if}
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

  .second {
    margin-top: 0.9rem;
  }

  .empty {
    margin: 0;
    font-weight: 500;
    text-align: center;
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
