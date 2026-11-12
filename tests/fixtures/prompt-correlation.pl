% Portable ACTOR checks: stale replies and prompt_ref/2-shaped payloads.
prompt_correlation_check :-
    toplevel_spawn(P, [session(true)]),
    toplevel_call(P, (input(first,X),input(prompt_ref(literal,payload),Y)),
                  [template(pair(X,Y)),limit(1),once(true)]),
    receive({prompt(P,R1,first) -> true},
            [timeout(5),on_timeout(throw(missing_first_prompt))]),
    respond(P,R1,one),
    receive({prompt(P,R2,prompt_ref(literal,payload)) -> true},
            [timeout(5),on_timeout(throw(missing_second_prompt))]),
    R1 \== R2,
    respond(P,R1,stale),
    respond(P,R2,two),
    receive({success(P,[pair(one,two)],false) -> true},
            [timeout(5),on_timeout(throw(missing_correlated_answer))]),
    toplevel_halt(P).
