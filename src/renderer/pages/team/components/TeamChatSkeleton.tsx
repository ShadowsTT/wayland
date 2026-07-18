import React from 'react';

/**
 * Message-area skeleton for a team chat column. Reserves the column layout so a
 * loading conversation (or a Suspense-lazy platform chat) fills in-place instead
 * of collapsing to a centered spinner and snapping the layout (#8). Static bars
 * only — no looping animation, so it stays calm under prefers-reduced-motion.
 */
const Bar: React.FC<{ w: string; alignEnd?: boolean }> = ({ w, alignEnd }) => (
  <div className={`flex ${alignEnd ? 'justify-end' : 'justify-start'}`}>
    <div className='h-40px rd-10px' style={{ width: w, background: 'var(--color-fill-2)' }} />
  </div>
);

const TeamChatSkeleton: React.FC = () => (
  <div
    data-testid='team-chat-skeleton'
    aria-hidden='true'
    className='flex flex-col flex-1 min-h-0 gap-16px px-16px py-20px overflow-hidden'
  >
    <Bar w='58%' />
    <Bar w='42%' alignEnd />
    <Bar w='66%' />
    <Bar w='50%' alignEnd />
    <Bar w='38%' />
  </div>
);

export default TeamChatSkeleton;
