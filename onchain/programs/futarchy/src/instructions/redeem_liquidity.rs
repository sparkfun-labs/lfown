use amm::cpi::accounts::RemoveLiquidity;
use amm::program::Amm;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token::{Token, TokenAccount};
use vault::cpi::accounts::UserVaultAction;
use vault::program::Vault;
use vault::VaultType;

use crate::errors::FutarchyError;
use crate::price_guard::sqrt_price_for;
use crate::state::dao::*;
use crate::state::moderator::*;
use crate::state::proposal::*;

#[event]
pub struct LiquidityRedeemed {
    pub proposal_id: u16,
    pub proposal: Pubkey,
    pub redeemer: Pubkey,
    pub winning_idx: u8,
}

#[derive(Accounts)]
pub struct RedeemLiquidity<'info> {
    // LFOwn fork: permissionless. The liquidity comes back to the DAO's liquidity authority,
    // not to whoever calls this, so there is nothing for the caller to gain but the crank.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        seeds = [
            PROPOSAL_SEED,
            proposal.moderator.as_ref(),
            &proposal.id.to_le_bytes()
        ],
        bump = proposal.bump,
        constraint = proposal.version != 0 @FutarchyError::InvalidVersion, // Don't allow historical proposals
        has_one = vault @ FutarchyError::InvalidVault,
    )]
    pub proposal: Box<Account<'info, ProposalAccount>>,

    /// CHECK: Validated via constraint and CPI
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,

    #[account(address = proposal.moderator @ FutarchyError::InvalidDAO)]
    pub moderator: Box<Account<'info, ModeratorAccount>>,
    #[account(
        mut,
        seeds = [DAO_SEED, moderator.base_mint.as_ref()],
        bump = dao.bump,
        constraint = dao.moderator == moderator.key() @ FutarchyError::InvalidDAO,
        constraint = dao.active_proposal == proposal.key() @ FutarchyError::LiquidityNotPrepared,
    )]
    pub dao: Box<Account<'info, DAOAccount>>,
    /// CHECK: the DAO's liquidity authority, checked by seeds; it signs the withdrawal.
    #[account(mut, seeds = [LIQUIDITY_SEED, dao.key().as_ref()], bump = dao.liquidity_authority_bump)]
    pub liquidity_authority: UncheckedAccount<'info>,

    /// CHECK: Winning pool - validated in handler against proposal.pools[winning_idx]
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,

    pub vault_program: Program<'info, Vault>,
    pub amm_program: Program<'info, Amm>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    // Remaining accounts layout (for N options):
    // remove_liquidity (4 accounts):
    //   0: reserve_a (pool's cond_quote reserve)
    //   1: reserve_b (pool's cond_base reserve)
    //   2: signer_cond_quote_ata
    //   3: signer_cond_base_ata
    //
    // redeem_winnings base (3 + 2N accounts):
    //   4: base_mint
    //   5: vault_base_ata
    //   6: user_base_ata
    //   7..7+2N: [cond_base_mint_i, user_cond_base_ata_i] for i in 0..N
    //
    // redeem_winnings quote (3 + 2N accounts):
    //   7+2N: quote_mint
    //   7+2N+1: vault_quote_ata
    //   7+2N+2: user_quote_ata
    //   7+2N+3..7+4N+3: [cond_quote_mint_i, user_cond_quote_ata_i] for i in 0..N
}

pub fn redeem_liquidity_handler<'info>(
    ctx: Context<'_, '_, 'info, 'info, RedeemLiquidity<'info>>,
) -> Result<()> {
    let dao_key = ctx.accounts.dao.key();
    let liquidity_bump = [ctx.accounts.dao.liquidity_authority_bump];
    let liquidity_seeds: [&[u8]; 3] = [LIQUIDITY_SEED, dao_key.as_ref(), &liquidity_bump];
    let liquidity_signer = &[&liquidity_seeds[..]];

    let proposal = &ctx.accounts.proposal;
    let num_options = proposal.num_options as usize;

    // Extract winning_idx from proposal state
    let ProposalState::Resolved(winning_idx) = proposal.state else {
        return err!(FutarchyError::InvalidState);
    };

    // Validate pool matches winning pool
    require!(
        ctx.accounts.pool.key() == proposal.pools[winning_idx as usize],
        FutarchyError::InvalidPools
    );

    // Validate remaining accounts length: 4 + 3 + 2N + 3 + 2N = 10 + 4N
    let expected_remaining = 10 + 4 * num_options;
    require!(
        ctx.remaining_accounts.len() >= expected_remaining,
        FutarchyError::InvalidRemainingAccounts
    );

    // LFOwn fork: every account the liquidity comes home through is the liquidity
    // authority's own associated account, and every conditional mint is this proposal's.
    // Anyone may call this, and it clears the DAO's active proposal: with stand-ins passed
    // here, nothing would be redeemed and the liquidity would be stranded for good.
    let la = ctx.accounts.liquidity_authority.key();
    let vault_key = ctx.accounts.vault.key();
    let ra = &ctx.remaining_accounts;
    let cmint = |kind: u8, i: usize| {
        Pubkey::find_program_address(&[b"cmint", vault_key.as_ref(), &[kind], &[i as u8]], &vault::ID).0
    };
    let w = winning_idx as usize;
    require_keys_eq!(ra[2].key(), get_associated_token_address(&la, &cmint(1, w)), FutarchyError::InvalidAccount);
    require_keys_eq!(ra[3].key(), get_associated_token_address(&la, &cmint(0, w)), FutarchyError::InvalidAccount);
    let base_mint = ctx.accounts.dao.token_mint;
    let quote_mint = ctx.accounts.dao.quote_mint;
    require_keys_eq!(ra[4].key(), base_mint, FutarchyError::InvalidMint);
    require_keys_eq!(ra[5].key(), get_associated_token_address(&vault_key, &base_mint), FutarchyError::InvalidAccount);
    require_keys_eq!(ra[6].key(), get_associated_token_address(&la, &base_mint), FutarchyError::InvalidAccount);
    let q = 7 + 2 * num_options;
    require_keys_eq!(ra[q].key(), quote_mint, FutarchyError::InvalidMint);
    require_keys_eq!(ra[q + 1].key(), get_associated_token_address(&vault_key, &quote_mint), FutarchyError::InvalidAccount);
    require_keys_eq!(ra[q + 2].key(), get_associated_token_address(&la, &quote_mint), FutarchyError::InvalidAccount);
    for i in 0..num_options {
        require_keys_eq!(ra[7 + 2 * i].key(), cmint(0, i), FutarchyError::InvalidAccount);
        require_keys_eq!(ra[8 + 2 * i].key(), get_associated_token_address(&la, &cmint(0, i)), FutarchyError::InvalidAccount);
        require_keys_eq!(ra[q + 3 + 2 * i].key(), cmint(1, i), FutarchyError::InvalidAccount);
        require_keys_eq!(ra[q + 4 + 2 * i].key(), get_associated_token_address(&la, &cmint(1, i)), FutarchyError::InvalidAccount);
    }

    // Read reserve amounts to determine how much to withdraw
    let reserve_a_data = ctx.remaining_accounts[0].try_borrow_data()?;
    let reserve_a = TokenAccount::try_deserialize(&mut &reserve_a_data[..])?;
    let amount_a = reserve_a.amount;
    drop(reserve_a_data);

    let reserve_b_data = ctx.remaining_accounts[1].try_borrow_data()?;
    let reserve_b = TokenAccount::try_deserialize(&mut &reserve_b_data[..])?;
    let amount_b = reserve_b.amount;
    drop(reserve_b_data);

    // 1. CPI to amm::remove_liquidity
    let remove_liq_ctx = CpiContext::new_with_signer(
        ctx.accounts.amm_program.to_account_info(),
        RemoveLiquidity {
            depositor: ctx.accounts.liquidity_authority.to_account_info(),
            pool: ctx.accounts.pool.to_account_info(),
            reserve_a: ctx.remaining_accounts[0].to_account_info(),
            reserve_b: ctx.remaining_accounts[1].to_account_info(),
            depositor_token_acc_a: ctx.remaining_accounts[2].to_account_info(),
            depositor_token_acc_b: ctx.remaining_accounts[3].to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        },
        liquidity_signer,
    );
    amm::cpi::remove_liquidity(remove_liq_ctx, amount_a, amount_b)?;

    // Build remaining accounts for redeem_winnings base
    // Indices: 7..7+2N
    let base_remaining_start = 7;
    let base_remaining_end = 7 + 2 * num_options;
    let base_remaining: Vec<AccountInfo<'info>> = ctx.remaining_accounts
        [base_remaining_start..base_remaining_end]
        .iter()
        .map(|a| a.to_account_info())
        .collect();

    // 2. CPI to vault::redeem_winnings for base tokens
    let redeem_base_ctx = CpiContext::new_with_signer(
        ctx.accounts.vault_program.to_account_info(),
        UserVaultAction {
            signer: ctx.accounts.liquidity_authority.to_account_info(),
            vault: ctx.accounts.vault.to_account_info(),
            mint: ctx.remaining_accounts[4].to_account_info(), // base_mint
            vault_ata: ctx.remaining_accounts[5].to_account_info(), // vault_base_ata
            user_ata: ctx.remaining_accounts[6].to_account_info(), // user_base_ata
            token_program: ctx.accounts.token_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
        liquidity_signer,
    )
    .with_remaining_accounts(base_remaining);

    vault::cpi::redeem_winnings(redeem_base_ctx, VaultType::Base)?;

    // Build remaining accounts for redeem_winnings quote
    // Indices: 7+2N+3..7+4N+3
    let quote_remaining_start = 7 + 2 * num_options + 3;
    let quote_remaining_end = 7 + 4 * num_options + 3;
    let quote_remaining: Vec<AccountInfo<'info>> = ctx.remaining_accounts
        [quote_remaining_start..quote_remaining_end]
        .iter()
        .map(|a| a.to_account_info())
        .collect();

    // 3. CPI to vault::redeem_winnings for quote tokens
    let quote_fixed_start = 7 + 2 * num_options;
    let redeem_quote_ctx = CpiContext::new_with_signer(
        ctx.accounts.vault_program.to_account_info(),
        UserVaultAction {
            signer: ctx.accounts.liquidity_authority.to_account_info(),
            vault: ctx.accounts.vault.to_account_info(),
            mint: ctx.remaining_accounts[quote_fixed_start].to_account_info(), // quote_mint
            vault_ata: ctx.remaining_accounts[quote_fixed_start + 1].to_account_info(), // vault_quote_ata
            user_ata: ctx.remaining_accounts[quote_fixed_start + 2].to_account_info(), // user_quote_ata
            token_program: ctx.accounts.token_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
        liquidity_signer,
    )
    .with_remaining_accounts(quote_remaining);

    vault::cpi::redeem_winnings(redeem_quote_ctx, VaultType::Quote)?;

    emit!(LiquidityRedeemed {
        proposal_id: proposal.id,
        proposal: proposal.key(),
        redeemer: ctx.accounts.payer.key(),
        winning_idx,
    });

    // The price the liquidity goes back into the pool at: the winning market's TWAP, over
    // the whole decision, rather than a checkpoint walked along the thin pool the markets
    // left behind (4th audit M4, M7). return_liquidity measures the pool against it.
    let twap = {
        let data = ctx.accounts.pool.try_borrow_data()?;
        amm::state::PoolAccount::try_deserialize(&mut &data[..])?.oracle.fetch_twap()?
    };
    let dao = &mut ctx.accounts.dao;
    if twap > 0 {
        let now = Clock::get()?.unix_timestamp;
        let sqrt_price = sqrt_price_for(twap);
        dao.price_checkpoint = sqrt_price;
        dao.price_checkpoint_at = now;
        dao.price_anchor = sqrt_price;
        dao.price_anchor_at = now;
    }

    // The DAO's liquidity is home again, with its authority: ready to go back into the pool,
    // and it must, before another proposal takes a share out of what is left there.
    dao.active_proposal = Pubkey::default();
    dao.pending_return = true;
    Ok(())
}
