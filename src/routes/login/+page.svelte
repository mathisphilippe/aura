<script lang="ts">
  import { supabase } from '$lib/supabaseClient';
  import { goto } from '$app/navigation';

  let isSignUp = $state(false);
  let email = $state('');
  let password = $state('');
  let username = $state('');
  let errorMessage = $state('');
  let loading = $state(false);

  async function handleAuth() {
    loading = true;
    errorMessage = '';

    try {
      if (isSignUp) {
        if (!username.trim()) {
          throw new Error('Un pseudo est requis.');
        }

        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { username: username.trim() } // Envoyé au trigger handle_new_user()
          }
        });

        if (error) throw error;
        goto('/');
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password
        });

        if (error) throw error;
        goto('/');
      }
    } catch (err: any) {
      errorMessage = err.message || 'Une erreur est survenue';
    } finally {
      loading = false;
    }
  }
</script>

<div style="max-width: 400px; margin: 60px auto; padding: 20px; font-family: sans-serif;">
  <h1 style="text-align: center;">⚡ Aura App</h1>
  <h3 style="text-align: center; color: #666;">
    {isSignUp ? 'Créer un compte' : 'Connexion'}
  </h3>

  {#if errorMessage}
    <div style="background: #fee2e2; color: #dc2626; padding: 10px; border-radius: 6px; margin-bottom: 15px; font-size: 14px;">
      {errorMessage}
    </div>
  {/if}

  <form onsubmit={(e) => { e.preventDefault(); handleAuth(); }} style="display: flex; flex-direction: column; gap: 12px;">
    {#if isSignUp}
      <div>
        <label for="username" style="font-size: 14px; font-weight: bold;">Pseudo</label>
        <input 
          id="username"
          type="text" 
          bind:value={username} 
          placeholder="Ex: Baptiste" 
          required 
          style="width: 100%; padding: 10px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px;"
        />
      </div>
    {/if}

    <div>
      <label for="email" style="font-size: 14px; font-weight: bold;">Email</label>
      <input 
        id="email"
        type="email" 
        bind:value={email} 
        placeholder="nom@exemple.com" 
        required 
        style="width: 100%; padding: 10px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px;"
      />
    </div>

    <div>
      <label for="password" style="font-size: 14px; font-weight: bold;">Mot de passe</label>
      <input 
        id="password"
        type="password" 
        bind:value={password} 
        placeholder="••••••••" 
        required 
        style="width: 100%; padding: 10px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px;"
      />
    </div>

    <button 
      type="submit" 
      disabled={loading}
      style="padding: 12px; background: #000; color: #fff; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; margin-top: 10px;"
    >
      {loading ? 'Chargement...' : (isSignUp ? "S'inscrire" : 'Se connecter')}
    </button>
  </form>

  <div style="text-align: center; margin-top: 20px;">
    <button 
      onclick={() => { isSignUp = !isSignUp; errorMessage = ''; }}
      style="background: none; border: none; color: #2563eb; cursor: pointer; text-decoration: underline; font-size: 14px;"
    >
      {isSignUp ? 'Déjà un compte ? Se connecter' : "Pas encore de compte ? S'inscrire"}
    </button>
  </div>
</div>