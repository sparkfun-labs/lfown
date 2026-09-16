use anchor_lang::prelude::*;

#[error_code]
pub enum FutarchyError {
    #[msg("Vault account mismatch")]
    InvalidVault,

    #[msg("Pool account mismatch")]
    InvalidPools,

    #[msg("Mint mismatch")]
    InvalidMint,

    #[msg("Invalid Pool Program")]
    InvalidPoolProgram,

    #[msg("Minimum 2 options required")]
    NotEnoughOptions,

    #[msg("Too many options")]
    TooManyOptions,

    #[msg("Invalid remaining accounts")]
    InvalidRemainingAccounts,

    #[msg("Invalid proposal state")]
    InvalidState,

    #[msg("Unauthorized")]
    Unauthorized,

    #[msg("Proposal has not expired yet")]
    ProposalNotExpired,

    #[msg("TWAP not ready")]
    TwapNotReady,

    #[msg("Counter overflow")]
    CounterOverflow,

    #[msg("Winning index exceeds number of options")]
    InvalidWinningIndex,

    #[msg("Invalid account version")]
    InvalidVersion,

    #[msg("Name exceeds 32 bytes")]
    NameTooLong,

    #[msg("Metadata CID exceeds 64 bytes")]
    MetadataTooLong,

    #[msg("Invalid DAO account")]
    InvalidDAO,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Invalid proposal parameters")]
    InvalidProposalParams,

    // LFOwn fork: on-chain execution of winning options.
    #[msg("The DAO does not hold its token's mint authority")]
    MintNotControlled,

    #[msg("Option 0 is the status quo and cannot carry actions")]
    NoActionsOnStatusQuo,

    #[msg("Option index out of range")]
    InvalidOptionIndex,

    #[msg("Too many actions for one option")]
    TooManyActions,

    #[msg("Invalid action")]
    InvalidAction,

    #[msg("The proposal has not been resolved")]
    ProposalNotResolved,

    #[msg("This option did not win")]
    OptionDidNotWin,

    #[msg("This action has already been executed")]
    ActionAlreadyExecuted,

    // LFOwn fork: liquidity and fees run through the DAO's own DAMM v2 position.
    #[msg("Withdrawal share must be between 1 and 9900 basis points")]
    InvalidWithdrawal,

    #[msg("The DAO already has a position")]
    PositionAlreadyAttached,

    #[msg("The DAO has no position attached")]
    PositionNotAttached,

    #[msg("The position does not belong to the DAO's pool, or the DAO does not hold it")]
    InvalidPosition,

    #[msg("The pool does not pair the DAO's token with its quote token")]
    InvalidPool,

    #[msg("Another proposal holds the DAO's liquidity")]
    ProposalAlreadyActive,

    #[msg("Liquidity has already been prepared for this proposal")]
    LiquidityAlreadyPrepared,

    #[msg("No liquidity has been prepared for this proposal")]
    LiquidityNotPrepared,

    #[msg("Nothing to withdraw from the position")]
    NothingToWithdraw,

    #[msg("Nothing to return to the pool")]
    NothingToReturn,

    #[msg("The raise has not succeeded")]
    RaiseNotSucceeded,

    #[msg("The raise did not pay this DAO's treasury and liquidity authority")]
    RaiseNotForThisDao,
}
