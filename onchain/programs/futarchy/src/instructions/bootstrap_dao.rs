// LFOwn addition to a fork of zcombinatorio/programs (AGPL-3.0).
//
// From a settled raise to a governed, liquid token in one transaction, with no key holding
// anything in between.
//
// The raise is opened with this DAO's PDAs as its recipients: its treasury share goes to
// the DAO treasury, and its pool share, with the token's mint authority, to the DAO's
// liquidity authority. That is what `lfown_raise::settle` pays. This instruction then, all
// at once:
//
//   1. settles the raise, as its pool operator: the raise pays exactly this DAO's addresses
//      and opens its claims, and cannot succeed any other way
//   2. opens the DAO
//   3. moves the mint authority from the liquidity authority to the DAO's mint authority
//   4. opens the DAMM v2 pool with everything the liquidity authority holds, at the price
//      those amounts imply — which is the raise's own price — with the position NFT minted
//      straight to the liquidity authority
//
// Anyone can call it — LFOwn's keeper does, the minute a raise settles — because there is
// nothing left to choose: the raise committed, before a single backer joined, to a hash of
// the DAO's name, withdrawal share and governance rules, and this instruction refuses any
// others. Backers are never left waiting on the creator to come back.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::Instruction, program::invoke_signed};
use anchor_lang::InstructionData;
use anchor_lang::system_program;
use anchor_spl::associated_token::{get_associated_token_address, AssociatedToken};
use anchor_spl::token::{self, spl_token::instruction::AuthorityType, Mint, SetAuthority, Token};
use anchor_spl::token_2022::Token2022;
use lfown_raise::program::LfownRaise;
use lfown_raise::state::{Raise, RaiseState};

use crate::constants::*;
use crate::cp_amm;
use crate::errors::FutarchyError;
use crate::liquidity::{liquidity_for_amounts, sqrt_price_for_amounts};
use crate::state::dao::*;
use crate::state::moderator::*;

#[event]
pub struct DAOBootstrapped {
    pub dao: Pubkey,
    pub raise: Pubkey,
    pub pool: Pubkey,
    pub position: Pubkey,
    pub base_amount: u64,
    pub quote_amount: u64,
    pub sqrt_price: u128,
    pub liquidity: u128,
}

#[derive(Accounts)]
#[instruction(name: String)]
pub struct BootstrapDAO<'info> {
    /// Pays for the DAO's accounts and the pool's creation. Chooses nothing.
    #[account(mut)]
    pub payer: Signer<'info>,

    // Still live: this instruction settles it. A raise can only succeed by becoming its DAO,
    // in this one instruction, so there is never a moment when its money sits with an
    // operator and no pool, or a DAO other than this one could claim it.
    #[account(
        mut,
        constraint = raise.state == RaiseState::Live @ FutarchyError::RaiseNotSucceeded,
        constraint = raise.treasury == treasury.key() @ FutarchyError::RaiseNotForThisDao,
        constraint = raise.pool_operator == liquidity_authority.key() @ FutarchyError::RaiseNotForThisDao,
    )]
    pub raise: Box<Account<'info, Raise>>,

    #[account(init, payer = payer, space = 8 + DAOAccount::INIT_SPACE, seeds = [DAO_SEED, raise.base_mint.as_ref()], bump)]
    pub dao: Box<Account<'info, DAOAccount>>,

    #[account(init, payer = payer, space = 8 + ModeratorAccount::INIT_SPACE, seeds = [MODERATOR_SEED, raise.base_mint.as_ref()], bump)]
    pub moderator: Box<Account<'info, ModeratorAccount>>,

    /// CHECK: the DAO's treasury PDA.
    #[account(seeds = [TREASURY_SEED, dao.key().as_ref()], bump)]
    pub treasury: UncheckedAccount<'info>,

    /// CHECK: the DAO's mint authority PDA.
    #[account(seeds = [MINT_AUTHORITY_SEED, dao.key().as_ref()], bump)]
    pub mint_authority: UncheckedAccount<'info>,

    /// CHECK: the DAO's liquidity authority PDA; it pays for and signs the pool's creation.
    #[account(mut, seeds = [LIQUIDITY_SEED, dao.key().as_ref()], bump)]
    pub liquidity_authority: UncheckedAccount<'info>,

    #[account(mut, address = raise.base_mint @ FutarchyError::InvalidMint)]
    pub base_mint: Box<Account<'info, Mint>>,

    #[account(address = raise.quote_mint @ FutarchyError::InvalidMint)]
    pub quote_mint: Box<Account<'info, Mint>>,

    /// CHECK: the raise's vaults; the raise program checks them against its own record.
    #[account(mut, address = raise.base_vault @ FutarchyError::InvalidAccount)]
    pub base_vault: UncheckedAccount<'info>,
    /// CHECK: as above.
    #[account(mut, address = raise.quote_vault @ FutarchyError::InvalidAccount)]
    pub quote_vault: UncheckedAccount<'info>,
    /// CHECK: the treasury's associated account for the coin, opened by the settlement.
    #[account(mut, address = get_associated_token_address(&treasury.key(), &quote_mint.key()) @ FutarchyError::InvalidAccount)]
    pub treasury_quote: UncheckedAccount<'info>,

    // The liquidity authority's *associated* accounts, and no others: the settlement pays
    // these, and the pool is opened from them. A token account of the caller's making,
    // owned by the same PDA but holding one unit, used to set the pool's price.
    /// CHECK: address fixed; opened by the settlement.
    #[account(mut, address = get_associated_token_address(&liquidity_authority.key(), &base_mint.key()) @ FutarchyError::InvalidAccount)]
    pub liquidity_base: UncheckedAccount<'info>,
    /// CHECK: address fixed; opened by the settlement.
    #[account(mut, address = get_associated_token_address(&liquidity_authority.key(), &quote_mint.key()) @ FutarchyError::InvalidAccount)]
    pub liquidity_quote: UncheckedAccount<'info>,

    /// CHECK: the position NFT's mint, a PDA of this program that DAMM v2 creates.
    #[account(mut, seeds = [POSITION_NFT_SEED, dao.key().as_ref()], bump)]
    pub position_nft_mint: UncheckedAccount<'info>,
    /// CHECK: created and validated by DAMM v2.
    #[account(mut)]
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: Meteora's pool authority, fixed.
    #[account(address = DAMM_POOL_AUTHORITY)]
    pub pool_authority: UncheckedAccount<'info>,
    /// CHECK: created and validated by DAMM v2 (seeded by the two mints).
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: created and validated by DAMM v2 (seeded by the position NFT).
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: created and validated by DAMM v2.
    #[account(mut)]
    pub token_a_vault: UncheckedAccount<'info>,
    /// CHECK: created and validated by DAMM v2.
    #[account(mut)]
    pub token_b_vault: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's event authority, validated by DAMM v2.
    pub event_authority: UncheckedAccount<'info>,

    pub cp_amm_program: Program<'info, cp_amm::program::CpAmm>,
    pub raise_program: Program<'info, LfownRaise>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

pub fn bootstrap_dao_handler(
    ctx: Context<BootstrapDAO>,
    name: String,
    withdrawal_bps: u16,
    governance: GovernanceConfig,
) -> Result<()> {
    require!(name.len() <= 32, FutarchyError::NameTooLong);
    governance.validate()?;
    require!(
        dao_commitment(&name, withdrawal_bps, &governance)? == ctx.accounts.raise.dao_commitment,
        FutarchyError::DaoCommitmentMismatch
    );
    require!(withdrawal_bps >= 1 && withdrawal_bps <= MAX_WITHDRAWAL_BPS, FutarchyError::InvalidWithdrawal);

    let dao_key = ctx.accounts.dao.key();
    let liquidity_bump = [ctx.bumps.liquidity_authority];
    let liquidity_seeds: [&[u8]; 3] = [LIQUIDITY_SEED, dao_key.as_ref(), &liquidity_bump];
    let nft_bump = [ctx.bumps.position_nft_mint];
    let nft_seeds: [&[u8]; 3] = [POSITION_NFT_SEED, dao_key.as_ref(), &nft_bump];

    // First the raise is settled, by the DAO's liquidity authority — the only signature the
    // raise accepts for a success. It pays the treasury and these two associated accounts,
    // hands over the mint authority, and opens claims; the pool below exists before the
    // instruction ends, so nobody can open one of their own first.
    settle_raise(&ctx.accounts, &liquidity_seeds)?;
    ctx.accounts.raise.reload()?;
    ctx.accounts.base_mint.reload()?;
    // Past its deadline the settlement marks the raise failed instead; then there is no DAO.
    require!(ctx.accounts.raise.state == RaiseState::Succeeded, FutarchyError::RaiseNotSucceeded);

    // The mint goes to the DAO before anything else touches it.
    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: ctx.accounts.liquidity_authority.to_account_info(),
                account_or_mint: ctx.accounts.base_mint.to_account_info(),
            },
            &[&liquidity_seeds],
        ),
        AuthorityType::MintTokens,
        Some(ctx.accounts.mint_authority.key()),
    )?;

    // The pool opens with exactly the raise's pool share, at the price it implies — the
    // backers' price, which the raise checked when it opened. Taken from the raise, not from
    // balances: anything someone sent to these accounts stays out of the price, and goes
    // back into the pool later with the rest of the DAO's liquidity.
    let base_amount = ctx.accounts.raise.tokens_for_pool;
    let quote_amount = ctx.accounts.raise.quote_to_pool;
    let sqrt_price = sqrt_price_for_amounts(base_amount, quote_amount, DAMM_MIN_SQRT_PRICE, DAMM_MAX_SQRT_PRICE)
        .ok_or(FutarchyError::InvalidPool)?;
    let liquidity = liquidity_for_amounts(base_amount, quote_amount, sqrt_price, DAMM_MIN_SQRT_PRICE, DAMM_MAX_SQRT_PRICE)
        .ok_or(FutarchyError::InvalidPool)?;

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.liquidity_authority.to_account_info(),
            },
        ),
        POOL_CREATION_LAMPORTS,
    )?;

    cp_amm::cpi::initialize_customizable_pool(
        CpiContext::new_with_signer(
            ctx.accounts.cp_amm_program.to_account_info(),
            cp_amm::cpi::accounts::InitializeCustomizablePool {
                creator: ctx.accounts.liquidity_authority.to_account_info(),
                position_nft_mint: ctx.accounts.position_nft_mint.to_account_info(),
                position_nft_account: ctx.accounts.position_nft_account.to_account_info(),
                payer: ctx.accounts.liquidity_authority.to_account_info(),
                pool_authority: ctx.accounts.pool_authority.to_account_info(),
                pool: ctx.accounts.pool.to_account_info(),
                position: ctx.accounts.position.to_account_info(),
                token_a_mint: ctx.accounts.base_mint.to_account_info(),
                token_b_mint: ctx.accounts.quote_mint.to_account_info(),
                token_a_vault: ctx.accounts.token_a_vault.to_account_info(),
                token_b_vault: ctx.accounts.token_b_vault.to_account_info(),
                payer_token_a: ctx.accounts.liquidity_base.to_account_info(),
                payer_token_b: ctx.accounts.liquidity_quote.to_account_info(),
                token_a_program: ctx.accounts.token_program.to_account_info(),
                token_b_program: ctx.accounts.token_program.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                event_authority: ctx.accounts.event_authority.to_account_info(),
                program: ctx.accounts.cp_amm_program.to_account_info(),
            },
            &[&liquidity_seeds, &nft_seeds],
        ),
        cp_amm::types::InitializeCustomizablePoolParameters {
            pool_fees: cp_amm::types::PoolFeeParameters {
                base_fee: cp_amm::types::BaseFeeParameters { data: POOL_BASE_FEE_DATA },
                compounding_fee_bps: 0,
                padding: 0,
                dynamic_fee: None,
            },
            sqrt_min_price: DAMM_MIN_SQRT_PRICE,
            sqrt_max_price: DAMM_MAX_SQRT_PRICE,
            has_alpha_vault: false,
            liquidity,
            sqrt_price,
            activation_type: 1, // by timestamp
            collect_fee_mode: 1, // fees in token B only: the ownership coin
            activation_point: None,
        },
    )?;

    // The DAO's admin only attaches a position on the manual path; proposals are open to all.
    let admin = ctx.accounts.raise.authority;
    let moderator_key = ctx.accounts.moderator.key();
    let base_mint = ctx.accounts.base_mint.key();
    let quote_mint = ctx.accounts.quote_mint.key();
    ctx.accounts.moderator.set_inner(ModeratorAccount {
        version: MODERATOR_VERSION,
        bump: ctx.bumps.moderator,
        name: name.clone(),
        quote_mint,
        base_mint,
        proposal_id_counter: 0,
        admin,
    });
    ctx.accounts.dao.set_inner(DAOAccount {
        version: DAO_VERSION,
        bump: ctx.bumps.dao,
        name: name.clone(),
        admin,
        token_mint: base_mint,
        quote_mint,
        moderator: moderator_key,
        pool: ctx.accounts.pool.key(),
        pool_type: PoolType::DAMM,
        treasury: ctx.accounts.treasury.key(),
        treasury_bump: ctx.bumps.treasury,
        mint_authority: ctx.accounts.mint_authority.key(),
        mint_authority_bump: ctx.bumps.mint_authority,
        liquidity_authority: ctx.accounts.liquidity_authority.key(),
        liquidity_authority_bump: ctx.bumps.liquidity_authority,
        position: ctx.accounts.position.key(),
        withdrawal_bps,
        active_proposal: Pubkey::default(),
        governance,
        // The pool opens at the raise's price, so that is the first checkpoint.
        price_checkpoint: sqrt_price,
        price_checkpoint_at: Clock::get()?.unix_timestamp,
        pending_return: false,
    });

    emit!(DAOBootstrapped {
        dao: dao_key,
        raise: ctx.accounts.raise.key(),
        pool: ctx.accounts.pool.key(),
        position: ctx.accounts.position.key(),
        base_amount,
        quote_amount,
        sqrt_price,
        liquidity,
    });
    Ok(())
}

/// What a raise commits to: sha256 of the DAO's name, its withdrawal share (u16, little
/// endian) and its governance config (borsh). The launch page computes the same bytes.
pub fn dao_commitment(name: &str, withdrawal_bps: u16, governance: &GovernanceConfig) -> Result<[u8; 32]> {
    let config = governance.try_to_vec()?;
    Ok(solana_sha256_hasher::hashv(&[name.as_bytes(), &withdrawal_bps.to_le_bytes(), &config]).to_bytes())
}

/// Settles the raise as its pool operator. Anchor's CPI helper would pass the operator as a
/// plain account, so the instruction is built here with the liquidity authority's PDA
/// signature; and it is a function of its own to keep the handler's stack frame small.
#[inline(never)]
fn settle_raise(a: &BootstrapDAO, liquidity_seeds: &[&[u8]; 3]) -> Result<()> {
    let settle_accounts = lfown_raise::cpi::accounts::Settle {
        raise: a.raise.to_account_info(),
        base_mint: a.base_mint.to_account_info(),
        quote_mint: a.quote_mint.to_account_info(),
        base_vault: a.base_vault.to_account_info(),
        quote_vault: a.quote_vault.to_account_info(),
        treasury: a.treasury.to_account_info(),
        treasury_quote: a.treasury_quote.to_account_info(),
        pool_operator: a.liquidity_authority.to_account_info(),
        operator_quote: a.liquidity_quote.to_account_info(),
        operator_base: a.liquidity_base.to_account_info(),
        cranker: a.payer.to_account_info(),
        token_program: a.token_program.to_account_info(),
        associated_token_program: a.associated_token_program.to_account_info(),
        system_program: a.system_program.to_account_info(),
    };
    let operator = a.liquidity_authority.key();
    let mut metas = settle_accounts.to_account_metas(None);
    for meta in metas.iter_mut().filter(|m| m.pubkey == operator) {
        meta.is_signer = true;
    }
    invoke_signed(
        &Instruction { program_id: a.raise_program.key(), accounts: metas, data: lfown_raise::instruction::Settle {}.data() },
        &settle_accounts.to_account_infos(),
        &[liquidity_seeds],
    )?;
    Ok(())
}
